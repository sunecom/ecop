"""Validated pure-water workflows for HeatExchanger, Compressor, and Vessel."""
import math

from basic_units import add_feed, mixture, require_finite, solve, vapor_fraction


DEFINITIONS = {
    'heat_exchanger': {
        'name': '纯水冷热物流换热', 'unit_type': 'HeatExchanger', 'unit_name': 'HX-02'},
    'compressor': {
        'name': '纯水蒸汽压缩', 'unit_type': 'Compressor', 'unit_name': 'C-01'},
    'vessel': {
        'name': '纯水气液分离', 'unit_type': 'Vessel', 'unit_name': 'V-01'},
}


def validate(data, number):
    module = data.get('module')
    if module == 'heat_exchanger':
        values = {
            'module': module,
            'hot_flow_kg_h': number(data, 'hot_flow_kg_h', '热侧流量', 10, 100000),
            'hot_inlet_temperature_C': number(
                data, 'hot_inlet_temperature_C', '热侧入口温度', 15, 90),
            'hot_pressure_kPa': number(data, 'hot_pressure_kPa', '热侧绝对压力', 100, 2000),
            'cold_flow_kg_h': number(data, 'cold_flow_kg_h', '冷侧流量', 10, 100000),
            'cold_inlet_temperature_C': number(
                data, 'cold_inlet_temperature_C', '冷侧入口温度', 5, 75),
            'cold_pressure_kPa': number(data, 'cold_pressure_kPa', '冷侧绝对压力', 100, 2000),
            'hot_outlet_temperature_C': number(
                data, 'hot_outlet_temperature_C', '热侧目标出口温度', 7, 88),
        }
        hot_in = values['hot_inlet_temperature_C']
        cold_in = values['cold_inlet_temperature_C']
        hot_out = values['hot_outlet_temperature_C']
        if hot_in - cold_in < 5:
            raise ValueError('热侧入口温度必须比冷侧入口温度至少高 5 °C')
        if not cold_in + 2 <= hot_out <= hot_in - 2:
            raise ValueError('热侧目标出口温度必须位于冷侧入口以上 2 °C、热侧入口以下 2 °C')
        return values
    if module == 'compressor':
        values = {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '蒸汽流量', 10, 100000),
            'inlet_temperature_C': number(data, 'inlet_temperature_C', '入口温度', 100, 400),
            'inlet_pressure_kPa': number(data, 'inlet_pressure_kPa', '入口绝对压力', 60, 2000),
            'outlet_pressure_kPa': number(data, 'outlet_pressure_kPa', '出口绝对压力', 100, 10000),
            'efficiency_percent': number(data, 'efficiency_percent', '绝热效率', 20, 95),
        }
        if values['outlet_pressure_kPa'] - values['inlet_pressure_kPa'] < 20:
            raise ValueError('出口压力必须比入口压力至少高 20 kPa')
        return values
    if module == 'vessel':
        return {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '纯水流量', 10, 100000),
            'inlet_temperature_C': number(data, 'inlet_temperature_C', '预热前入口温度', 5, 80),
            'pressure_kPa': number(data, 'pressure_kPa', '分离绝对压力', 60, 1000),
            'feed_vapor_percent': number(data, 'feed_vapor_percent', '两相进料汽相比例', 5, 95),
        }
    return None


def heat_rate(stream_in, stream_out):
    return stream_in['mass_flow_kg_s'] * (
        mixture(stream_out)['enthalpy_kJ_kg'] - mixture(stream_in)['enthalpy_kJ_kg'])


def run_heat_exchanger(values, tool):
    hot_in = add_feed(tool, 'HOT-IN', values['hot_inlet_temperature_C'],
                      values['hot_pressure_kPa'], values['hot_flow_kg_h'])
    cold_in = add_feed(tool, 'COLD-IN', values['cold_inlet_temperature_C'],
                       values['cold_pressure_kPa'], values['cold_flow_kg_h'])
    if vapor_fraction(hot_in) > 1e-6 or vapor_fraction(cold_in) > 1e-6:
        raise RuntimeError('换热器入口必须为单液相纯水')
    for name in ('HOT-OUT', 'COLD-OUT'):
        tool('dwsim_stream_add_material', name=name)
    tool('dwsim_unitop_add', type='HeatExchanger', name='HX-02')
    tool('dwsim_unitop_connect', unitop='HX-02', feed_stream='HOT-IN', feed_port=0,
         product_stream='HOT-OUT', product_port=0)
    tool('dwsim_unitop_connect', unitop='HX-02', feed_stream='COLD-IN', feed_port=1,
         product_stream='COLD-OUT', product_port=1)
    applied = tool('dwsim_unitop_set', name='HX-02', properties={
        'CalculationMode': 'CalcTempColdOut',
        'HotSideOutletTemperature': values['hot_outlet_temperature_C'] + 273.15,
        'HotSidePressureDrop': 0,
        'ColdSidePressureDrop': 0,
    })
    check, solved, unit = solve(
        tool, 'HX-02', {'HOT-IN', 'HOT-OUT', 'COLD-IN', 'COLD-OUT', 'HX-02'})
    hot_in = tool('dwsim_stream_get_results', name='HOT-IN')
    hot_out = tool('dwsim_stream_get_results', name='HOT-OUT')
    cold_in = tool('dwsim_stream_get_results', name='COLD-IN')
    cold_out = tool('dwsim_stream_get_results', name='COLD-OUT')
    streams = {'hot_in': hot_in, 'hot_out': hot_out, 'cold_in': cold_in, 'cold_out': cold_out}
    finite = {}
    for label, stream in streams.items():
        finite.update({
            f'{label}_flow': stream.get('mass_flow_kg_s'),
            f'{label}_temperature': stream.get('temperature_K'),
            f'{label}_pressure': stream.get('pressure_Pa'),
            f'{label}_enthalpy': mixture(stream).get('enthalpy_kJ_kg'),
            f'{label}_vapor': vapor_fraction(stream),
        })
    require_finite('换热器引擎结果', **finite)
    hot_mass_residual = (hot_in['mass_flow_kg_s'] - hot_out['mass_flow_kg_s']) * 3600
    cold_mass_residual = (cold_in['mass_flow_kg_s'] - cold_out['mass_flow_kg_s']) * 3600
    hot_release = -heat_rate(hot_in, hot_out)
    cold_gain = heat_rate(cold_in, cold_out)
    heat_balance_residual = hot_release - cold_gain
    heat_balance_relative = abs(heat_balance_residual) / max(abs(hot_release), abs(cold_gain), 1e-12)
    hot_out_temperature = hot_out['temperature_K'] - 273.15
    cold_out_temperature = cold_out['temperature_K'] - 273.15
    results = {
        'hot_outlet_temperature_C': hot_out_temperature,
        'cold_outlet_temperature_C': cold_out_temperature,
        'hot_outlet_pressure_kPa': hot_out['pressure_Pa'] / 1000,
        'cold_outlet_pressure_kPa': cold_out['pressure_Pa'] / 1000,
        'heat_duty_kW': (hot_release + cold_gain) / 2,
        'hot_side_heat_release_kW': hot_release,
        'cold_side_heat_gain_kW': cold_gain,
        'heat_balance_residual_kW': heat_balance_residual,
        'heat_balance_relative': heat_balance_relative,
        'hot_mass_residual_kg_h': hot_mass_residual,
        'cold_mass_residual_kg_h': cold_mass_residual,
    }
    require_finite('换热器派生结果', **results)
    if max(abs(hot_mass_residual), abs(cold_mass_residual)) > 1e-6:
        raise RuntimeError('换热器两侧物料衡算未通过')
    if heat_balance_relative > 1e-4:
        raise RuntimeError('换热器两侧热量衡算未通过')
    if abs(hot_out_temperature - values['hot_outlet_temperature_C']) > 0.02:
        raise RuntimeError('换热器热侧出口温度未达到目标')
    if cold_out_temperature >= values['hot_inlet_temperature_C'] - 1e-6:
        raise RuntimeError('换热器出口温度发生交叉')
    if any(vapor_fraction(stream) > 1e-6 for stream in streams.values()):
        raise RuntimeError('换热器工况产生汽相，超出当前单液相边界')
    return {
        'results': results,
        'comparison': {'metric': 'heat_duty_kW', 'label': '换热负荷',
                       'unit': 'kW', 'value': results['heat_duty_kW']},
        'raw': {**streams, 'unit': unit, 'check': check, 'solve': solved, 'applied': applied},
    }


def run_compressor(values, tool):
    feed = add_feed(tool, 'FEED', values['inlet_temperature_C'],
                    values['inlet_pressure_kPa'], values['flow_kg_h'])
    tool('dwsim_stream_add_material', name='PRODUCT')
    tool('dwsim_unitop_add', type='Compressor', name='C-01')
    tool('dwsim_unitop_connect', unitop='C-01', feed_stream='FEED', product_stream='PRODUCT')
    applied = tool('dwsim_unitop_set', name='C-01', properties={
        'CalcMode': 'OutletPressure',
        'POut': values['outlet_pressure_kPa'] * 1000,
        'AdiabaticEfficiency': values['efficiency_percent'],
    })
    check, solved, unit = solve(tool, 'C-01', {'FEED', 'PRODUCT', 'C-01'})
    feed = tool('dwsim_stream_get_results', name='FEED')
    product = tool('dwsim_stream_get_results', name='PRODUCT')
    feed_vapor = vapor_fraction(feed)
    require_finite('压缩机入口结果', vapor_fraction=feed_vapor)
    if feed_vapor < 0.999999:
        raise ValueError('压缩机仅接受纯水蒸汽入口，当前工况含液相')
    power = float(unit['properties']['Power Required']['value'])
    require_finite(
        '压缩机引擎结果', feed_flow=feed.get('mass_flow_kg_s'),
        feed_temperature=feed.get('temperature_K'), feed_pressure=feed.get('pressure_Pa'),
        feed_enthalpy=mixture(feed).get('enthalpy_kJ_kg'), feed_vapor=vapor_fraction(feed),
        product_flow=product.get('mass_flow_kg_s'), product_temperature=product.get('temperature_K'),
        product_pressure=product.get('pressure_Pa'),
        product_enthalpy=mixture(product).get('enthalpy_kJ_kg'),
        product_vapor=vapor_fraction(product), power=power,
    )
    mass_residual = (feed['mass_flow_kg_s'] - product['mass_flow_kg_s']) * 3600
    enthalpy_power = product['mass_flow_kg_s'] * (
        mixture(product)['enthalpy_kJ_kg'] - mixture(feed)['enthalpy_kJ_kg'])
    power_residual = power - enthalpy_power
    power_residual_relative = abs(power_residual) / max(abs(power), abs(enthalpy_power), 1e-12)
    outlet_temperature = product['temperature_K'] - 273.15
    outlet_pressure = product['pressure_Pa'] / 1000
    results = {
        'outlet_flow_kg_h': product['mass_flow_kg_s'] * 3600,
        'outlet_temperature_C': outlet_temperature,
        'outlet_pressure_kPa': outlet_pressure,
        'outlet_vapor_fraction': vapor_fraction(product),
        'temperature_rise_C': outlet_temperature - values['inlet_temperature_C'],
        'pressure_ratio': outlet_pressure / values['inlet_pressure_kPa'],
        'power_required_kW': power,
        'enthalpy_power_kW': enthalpy_power,
        'power_residual_kW': power_residual,
        'power_residual_relative': power_residual_relative,
        'mass_residual_kg_h': mass_residual,
        'adiabatic_efficiency_percent': values['efficiency_percent'],
    }
    require_finite('压缩机派生结果', **results)
    if abs(mass_residual) > 1e-6 or power_residual_relative > 1e-4:
        raise RuntimeError('压缩机质量或功率衡算未通过')
    if abs(outlet_pressure - values['outlet_pressure_kPa']) > 0.02:
        raise RuntimeError('压缩机出口压力未达到目标')
    if power <= 0 or results['temperature_rise_C'] <= 0:
        raise RuntimeError('压缩机功率或温升方向无效')
    if vapor_fraction(product) < 0.999999:
        raise RuntimeError('压缩机出口不再是纯水蒸汽')
    return {
        'results': results,
        'comparison': {'metric': 'power_required_kW', 'label': '压缩功率',
                       'unit': 'kW', 'value': power},
        'raw': {'feed': feed, 'product': product, 'unit': unit, 'check': check,
                'solve': solved, 'applied': applied},
    }


def run_vessel(values, tool):
    raw_feed = add_feed(tool, 'RAW-FEED', values['inlet_temperature_C'],
                        values['pressure_kPa'], values['flow_kg_h'])
    if vapor_fraction(raw_feed) > 1e-6:
        raise RuntimeError('分离器预热前入口必须为单液相纯水')
    for name in ('TWO-PHASE', 'VAPOR', 'LIQUID'):
        tool('dwsim_stream_add_material', name=name)
    tool('dwsim_unitop_add', type='Heater', name='FLASH-01')
    tool('dwsim_unitop_connect', unitop='FLASH-01', feed_stream='RAW-FEED',
         product_stream='TWO-PHASE')
    flash_applied = tool('dwsim_unitop_set', name='FLASH-01', properties={
        'CalcMode': 'OutletVaporFraction',
        'OutletVaporFraction': values['feed_vapor_percent'] / 100,
        'DeltaP': 0,
        'Eficiencia': 100,
    })
    tool('dwsim_unitop_add', type='Vessel', name='V-01')
    tool('dwsim_unitop_connect', unitop='V-01', feed_stream='TWO-PHASE', feed_port=0,
         product_stream='VAPOR', product_port=0)
    tool('dwsim_unitop_connect', unitop='V-01', product_stream='LIQUID', product_port=1)
    required = {'RAW-FEED', 'TWO-PHASE', 'VAPOR', 'LIQUID', 'FLASH-01', 'V-01'}
    check, solved, unit = solve(tool, 'V-01', required)
    flash_unit = tool('dwsim_unitop_get_results', name='FLASH-01')
    raw_feed = tool('dwsim_stream_get_results', name='RAW-FEED')
    two_phase = tool('dwsim_stream_get_results', name='TWO-PHASE')
    vapor = tool('dwsim_stream_get_results', name='VAPOR')
    liquid = tool('dwsim_stream_get_results', name='LIQUID')
    streams = {'raw_feed': raw_feed, 'two_phase': two_phase, 'vapor': vapor, 'liquid': liquid}
    finite = {}
    for label, stream in streams.items():
        finite.update({
            f'{label}_flow': stream.get('mass_flow_kg_s'),
            f'{label}_temperature': stream.get('temperature_K'),
            f'{label}_pressure': stream.get('pressure_Pa'),
            f'{label}_enthalpy': mixture(stream).get('enthalpy_kJ_kg'),
            f'{label}_vapor': vapor_fraction(stream),
        })
    require_finite('分离器引擎结果', **finite)
    feed_flow = two_phase['mass_flow_kg_s']
    feed_vapor = vapor_fraction(two_phase)
    mass_residual = (feed_flow - vapor['mass_flow_kg_s'] - liquid['mass_flow_kg_s']) * 3600
    vapor_split_residual = (vapor['mass_flow_kg_s'] - feed_flow * feed_vapor) * 3600
    liquid_split_residual = (
        liquid['mass_flow_kg_s'] - feed_flow * (1 - feed_vapor)) * 3600
    enthalpy_in = feed_flow * mixture(two_phase)['enthalpy_kJ_kg']
    enthalpy_out = (vapor['mass_flow_kg_s'] * mixture(vapor)['enthalpy_kJ_kg'] +
                    liquid['mass_flow_kg_s'] * mixture(liquid)['enthalpy_kJ_kg'])
    enthalpy_residual = enthalpy_out - enthalpy_in
    enthalpy_residual_relative = abs(enthalpy_residual) / max(abs(enthalpy_in), 1e-12)
    results = {
        'flash_temperature_C': two_phase['temperature_K'] - 273.15,
        'separation_pressure_kPa': two_phase['pressure_Pa'] / 1000,
        'feed_vapor_fraction': feed_vapor,
        'vapor_product_kg_h': vapor['mass_flow_kg_s'] * 3600,
        'liquid_product_kg_h': liquid['mass_flow_kg_s'] * 3600,
        'vapor_product_vapor_fraction': vapor_fraction(vapor),
        'liquid_product_vapor_fraction': vapor_fraction(liquid),
        'mass_residual_kg_h': mass_residual,
        'vapor_split_residual_kg_h': vapor_split_residual,
        'liquid_split_residual_kg_h': liquid_split_residual,
        'enthalpy_residual_kW': enthalpy_residual,
        'enthalpy_residual_relative': enthalpy_residual_relative,
    }
    require_finite('分离器派生结果', **results)
    if not 1e-6 < feed_vapor < 1 - 1e-6:
        raise RuntimeError('Vessel 入口未形成真实气液两相')
    if vapor_fraction(vapor) < 0.999999 or vapor_fraction(liquid) > 1e-6:
        raise RuntimeError('Vessel 气液出口相态不纯')
    if max(abs(mass_residual), abs(vapor_split_residual), abs(liquid_split_residual)) > 1e-6:
        raise RuntimeError('Vessel 质量或汽液分配闭合未通过')
    if enthalpy_residual_relative > 1e-4:
        raise RuntimeError('Vessel 分离前后焓流闭合未通过')
    if abs(feed_vapor - values['feed_vapor_percent'] / 100) > 1e-6:
        raise RuntimeError('Vessel 两相进料汽相比例未达到目标')
    return {
        'results': results,
        'comparison': {'metric': 'vapor_product_kg_h', 'label': '汽相产品流量',
                       'unit': 'kg/h', 'value': results['vapor_product_kg_h']},
        'raw': {**streams, 'unit': unit, 'flash_unit': flash_unit, 'check': check,
                'solve': solved, 'flash_applied': flash_applied},
    }


def run(values, tool):
    runners = {
        'heat_exchanger': run_heat_exchanger,
        'compressor': run_compressor,
        'vessel': run_vessel,
    }
    return runners[values['module']](values, tool)
