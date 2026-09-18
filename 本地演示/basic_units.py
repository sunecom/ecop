"""Validated pure-water workflows for Mixer, Splitter, and Valve."""
import math


DEFINITIONS = {
    'mixer': {'name': '两股纯水混合', 'unit_type': 'Mixer', 'unit_name': 'MIX-01'},
    'splitter': {'name': '纯水按比例分流', 'unit_type': 'Splitter', 'unit_name': 'SPL-01'},
    'valve': {'name': '纯水阀门节流', 'unit_type': 'Valve', 'unit_name': 'VLV-01'},
}


def validate(data, number):
    module = data.get('module')
    if module == 'mixer':
        values = {
            'module': module,
            'feed1_flow_kg_h': number(data, 'feed1_flow_kg_h', '1号进料流量', 10, 100000),
            'feed1_temperature_C': number(data, 'feed1_temperature_C', '1号进料温度', 5, 90),
            'feed1_pressure_kPa': number(data, 'feed1_pressure_kPa', '1号进料绝对压力', 100, 2000),
            'feed2_flow_kg_h': number(data, 'feed2_flow_kg_h', '2号进料流量', 10, 100000),
            'feed2_temperature_C': number(data, 'feed2_temperature_C', '2号进料温度', 5, 90),
            'feed2_pressure_kPa': number(data, 'feed2_pressure_kPa', '2号进料绝对压力', 100, 2000),
        }
        if abs(values['feed1_pressure_kPa'] - values['feed2_pressure_kPa']) > 0.1:
            raise ValueError('两股进料绝对压力差必须不超过 0.1 kPa')
        return values
    if module == 'splitter':
        return {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '进料流量', 10, 100000),
            'temperature_C': number(data, 'temperature_C', '入口温度', 5, 90),
            'pressure_kPa': number(data, 'pressure_kPa', '入口绝对压力', 100, 2000),
            'outlet1_percent': number(data, 'outlet1_percent', '1号出口分流比', 1, 99),
        }
    if module == 'valve':
        values = {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '进料流量', 10, 100000),
            'inlet_temperature_C': number(data, 'inlet_temperature_C', '入口温度', 5, 90),
            'inlet_pressure_kPa': number(data, 'inlet_pressure_kPa', '入口绝对压力', 200, 10000),
            'outlet_pressure_kPa': number(data, 'outlet_pressure_kPa', '出口绝对压力', 60, 9990),
        }
        if values['inlet_pressure_kPa'] - values['outlet_pressure_kPa'] < 10:
            raise ValueError('入口压力必须比出口压力至少高 10 kPa')
        return values
    return None


def mixture(stream):
    return next(phase for phase in stream['phases']
                if phase['name'].lower() in ('mixture', 'overall'))


def vapor_fraction(stream):
    return next(phase['fraction'] for phase in stream['phases']
                if phase['name'].lower() == 'vapor')


def add_feed(tool, name, temperature_C, pressure_kPa, flow_kg_h):
    flow_kg_s = flow_kg_h / 3600
    tool('dwsim_stream_add_material', name=name, temperature_K=temperature_C + 273.15,
         pressure_Pa=pressure_kPa * 1000, mass_flow_kg_s=flow_kg_s,
         composition={'Water': 1.0})
    tool('dwsim_stream_set_conditions', name=name, mass_flow_kg_s=flow_kg_s)
    actual = tool('dwsim_stream_get_results', name=name)
    if not math.isclose(actual['mass_flow_kg_s'], flow_kg_s, rel_tol=1e-8):
        raise RuntimeError(f'引擎{name}流量与输入不一致')
    return actual


def solve(tool, unit_name, required):
    check = tool('dwsim_flowsheet_check')
    if not check.get('ready'):
        raise RuntimeError('流程预检查未通过')
    solved = tool('dwsim_solve_run', timeout_s=60)
    if not solved.get('ok'):
        raise RuntimeError('引擎求解失败')
    calculated = {item['name'] for item in solved.get('objects', []) if item.get('calculated')}
    if not required.issubset(calculated):
        raise RuntimeError(f'计算对象未全部完成: {sorted(required - calculated)}')
    unit = tool('dwsim_unitop_get_results', name=unit_name)
    if not unit.get('calculated'):
        raise RuntimeError(f'{unit_name}未完成计算')
    return check, solved, unit


def run_mixer(values, tool):
    feed1 = add_feed(tool, 'FEED-1', values['feed1_temperature_C'],
                     values['feed1_pressure_kPa'], values['feed1_flow_kg_h'])
    feed2 = add_feed(tool, 'FEED-2', values['feed2_temperature_C'],
                     values['feed2_pressure_kPa'], values['feed2_flow_kg_h'])
    tool('dwsim_stream_add_material', name='PRODUCT')
    tool('dwsim_unitop_add', type='Mixer', name='MIX-01')
    tool('dwsim_unitop_connect', unitop='MIX-01', feed_stream='FEED-1', feed_port=0,
         product_stream='PRODUCT', product_port=0)
    tool('dwsim_unitop_connect', unitop='MIX-01', feed_stream='FEED-2', feed_port=1)
    check, solved, unit = solve(tool, 'MIX-01', {'FEED-1', 'FEED-2', 'PRODUCT', 'MIX-01'})
    feed1 = tool('dwsim_stream_get_results', name='FEED-1')
    feed2 = tool('dwsim_stream_get_results', name='FEED-2')
    product = tool('dwsim_stream_get_results', name='PRODUCT')
    mass_in = feed1['mass_flow_kg_s'] + feed2['mass_flow_kg_s']
    mass_residual = (mass_in - product['mass_flow_kg_s']) * 3600
    enthalpy_in = (feed1['mass_flow_kg_s'] * mixture(feed1)['enthalpy_kJ_kg'] +
                   feed2['mass_flow_kg_s'] * mixture(feed2)['enthalpy_kJ_kg'])
    enthalpy_out = product['mass_flow_kg_s'] * mixture(product)['enthalpy_kJ_kg']
    energy_residual = enthalpy_out - enthalpy_in
    energy_residual_relative = abs(energy_residual) / max(abs(enthalpy_in), 1e-12)
    expected_pressure = min(values['feed1_pressure_kPa'], values['feed2_pressure_kPa'])
    if abs(mass_residual) > 1e-6 or energy_residual_relative > 1e-4:
        raise RuntimeError('混合器质量或焓流衡算未通过')
    if abs(product['pressure_Pa'] / 1000 - expected_pressure) > 0.02:
        raise RuntimeError('混合器出口压力校核未通过')
    if any(vapor_fraction(stream) > 1e-6 for stream in (feed1, feed2, product)):
        raise RuntimeError('混合工况产生汽相，超出当前单液相边界')
    results = {
        'outlet_flow_kg_h': product['mass_flow_kg_s'] * 3600,
        'outlet_temperature_C': product['temperature_K'] - 273.15,
        'outlet_pressure_kPa': product['pressure_Pa'] / 1000,
        'outlet_vapor_fraction': vapor_fraction(product),
        'mass_residual_kg_h': mass_residual,
        'enthalpy_flow_residual_kW': energy_residual,
        'enthalpy_flow_residual_relative': energy_residual_relative,
    }
    return {
        'results': results,
        'comparison': {'metric': 'outlet_temperature_C',
                       'label': '混合出口温度', 'unit': '°C',
                       'value': results['outlet_temperature_C']},
        'raw': {'feed1': feed1, 'feed2': feed2, 'product': product, 'unit': unit,
                'check': check, 'solve': solved, 'applied': []},
    }


def run_splitter(values, tool):
    feed = add_feed(tool, 'FEED', values['temperature_C'], values['pressure_kPa'],
                    values['flow_kg_h'])
    tool('dwsim_stream_add_material', name='PRODUCT-1')
    tool('dwsim_stream_add_material', name='PRODUCT-2')
    tool('dwsim_unitop_add', type='Splitter', name='SPL-01')
    tool('dwsim_unitop_connect', unitop='SPL-01', feed_stream='FEED',
         product_stream='PRODUCT-1', product_port=0)
    tool('dwsim_unitop_connect', unitop='SPL-01', product_stream='PRODUCT-2', product_port=1)
    applied = tool('dwsim_unitop_set', name='SPL-01',
                   properties={'OperationMode': 'SplitRatios',
                               'SR1': values['outlet1_percent'] / 100})
    check, solved, unit = solve(
        tool, 'SPL-01', {'FEED', 'PRODUCT-1', 'PRODUCT-2', 'SPL-01'})
    feed = tool('dwsim_stream_get_results', name='FEED')
    product1 = tool('dwsim_stream_get_results', name='PRODUCT-1')
    product2 = tool('dwsim_stream_get_results', name='PRODUCT-2')
    feed_flow = feed['mass_flow_kg_s']
    mass_residual = (feed_flow - product1['mass_flow_kg_s'] - product2['mass_flow_kg_s']) * 3600
    outlet1_fraction = product1['mass_flow_kg_s'] / feed_flow
    outlet2_fraction = product2['mass_flow_kg_s'] / feed_flow
    expected_fraction = values['outlet1_percent'] / 100
    if abs(mass_residual) > 1e-6:
        raise RuntimeError('分流器物料衡算未通过')
    if abs(outlet1_fraction - expected_fraction) > 1e-6 or abs(
            outlet2_fraction - (1 - expected_fraction)) > 1e-6:
        raise RuntimeError('引擎分流比未达到目标')
    for product in (product1, product2):
        if abs(product['temperature_K'] - feed['temperature_K']) > 0.02:
            raise RuntimeError('分流器出口温度未保持')
        if abs(product['pressure_Pa'] - feed['pressure_Pa']) > 20:
            raise RuntimeError('分流器出口压力未保持')
    results = {
        'outlet1_flow_kg_h': product1['mass_flow_kg_s'] * 3600,
        'outlet2_flow_kg_h': product2['mass_flow_kg_s'] * 3600,
        'outlet1_fraction': outlet1_fraction,
        'outlet2_fraction': outlet2_fraction,
        'outlet_temperature_C': product1['temperature_K'] - 273.15,
        'outlet_pressure_kPa': product1['pressure_Pa'] / 1000,
        'mass_residual_kg_h': mass_residual,
    }
    return {
        'results': results,
        'comparison': {'metric': 'outlet1_flow_kg_h',
                       'label': '1号出口流量', 'unit': 'kg/h',
                       'value': results['outlet1_flow_kg_h']},
        'raw': {'feed': feed, 'product1': product1, 'product2': product2, 'unit': unit,
                'check': check, 'solve': solved, 'applied': applied},
    }


def run_valve(values, tool):
    feed = add_feed(tool, 'FEED', values['inlet_temperature_C'],
                    values['inlet_pressure_kPa'], values['flow_kg_h'])
    tool('dwsim_stream_add_material', name='PRODUCT')
    tool('dwsim_unitop_add', type='Valve', name='VLV-01')
    tool('dwsim_unitop_connect', unitop='VLV-01', feed_stream='FEED', product_stream='PRODUCT')
    applied = tool('dwsim_unitop_set', name='VLV-01',
                   properties={'CalcMode': 'OutletPressure',
                               'OutletPressure': values['outlet_pressure_kPa'] * 1000})
    check, solved, unit = solve(tool, 'VLV-01', {'FEED', 'PRODUCT', 'VLV-01'})
    feed = tool('dwsim_stream_get_results', name='FEED')
    product = tool('dwsim_stream_get_results', name='PRODUCT')
    mass_residual = (feed['mass_flow_kg_s'] - product['mass_flow_kg_s']) * 3600
    inlet_enthalpy = mixture(feed)['enthalpy_kJ_kg']
    outlet_enthalpy = mixture(product)['enthalpy_kJ_kg']
    enthalpy_residual = outlet_enthalpy - inlet_enthalpy
    enthalpy_residual_relative = abs(enthalpy_residual) / max(abs(inlet_enthalpy), 1e-12)
    outlet_pressure = product['pressure_Pa'] / 1000
    if vapor_fraction(feed) > 1e-6:
        raise RuntimeError('阀门入口并非单液相，超出当前模块边界')
    if abs(mass_residual) > 1e-6 or enthalpy_residual_relative > 1e-4:
        raise RuntimeError('阀门质量或等焓校核未通过')
    if abs(outlet_pressure - values['outlet_pressure_kPa']) > 0.02:
        raise RuntimeError('阀门出口压力未达到目标')
    results = {
        'outlet_flow_kg_h': product['mass_flow_kg_s'] * 3600,
        'outlet_temperature_C': product['temperature_K'] - 273.15,
        'outlet_pressure_kPa': outlet_pressure,
        'pressure_drop_kPa': values['inlet_pressure_kPa'] - outlet_pressure,
        'outlet_vapor_fraction': vapor_fraction(product),
        'mass_residual_kg_h': mass_residual,
        'enthalpy_residual_kJ_kg': enthalpy_residual,
        'enthalpy_residual_relative': enthalpy_residual_relative,
    }
    return {
        'results': results,
        'comparison': {'metric': 'pressure_drop_kPa',
                       'label': '阀门压降', 'unit': 'kPa',
                       'value': results['pressure_drop_kPa']},
        'raw': {'feed': feed, 'product': product, 'unit': unit, 'check': check,
                'solve': solved, 'applied': applied},
    }


def run(values, tool):
    runners = {'mixer': run_mixer, 'splitter': run_splitter, 'valve': run_valve}
    return runners[values['module']](values, tool)
