"""Fixed pure-water preheat, evaporation, and separation workflow."""
import math

from basic_units import add_feed, mixture, require_finite, solve, vapor_fraction


DEFINITIONS = {
    'preheat_evap_separator': {
        'name': '预热—蒸发—汽液分离固定模板',
        'unit_type': 'Heater + Heater + Vessel',
        'unit_name': 'P4-01',
    },
}

PRESSURE_TOLERANCE_KPA = 0.02
TEMPERATURE_TOLERANCE_C = 0.02


def validate(data, number):
    if data.get('module') != 'preheat_evap_separator':
        return None
    values = {
        'module': 'preheat_evap_separator',
        'flow_kg_h': number(data, 'flow_kg_h', '进料流量', 10, 100000),
        'feed_temperature_C': number(data, 'feed_temperature_C', '进料温度', 5, 80),
        'pressure_kPa': number(data, 'pressure_kPa', '运行绝对压力', 60, 1000),
        'preheat_temperature_C': number(data, 'preheat_temperature_C', '预热目标温度', 7, 300),
        'vapor_percent': number(data, 'vapor_percent', '目标汽化比例', 5, 80),
    }
    if values['preheat_temperature_C'] - values['feed_temperature_C'] < 2:
        raise ValueError('预热目标温度必须比进料温度至少高 2 °C')
    return values


def stream_state(name, stream):
    mix = mixture(stream)
    vapor = vapor_fraction(stream)
    values = {
        'mass_flow_kg_s': stream.get('mass_flow_kg_s'),
        'temperature_K': stream.get('temperature_K'),
        'pressure_Pa': stream.get('pressure_Pa'),
        'enthalpy_kJ_kg': mix.get('enthalpy_kJ_kg'),
        'vapor_fraction': vapor,
    }
    require_finite(f'{name}引擎结果', **values)
    return values


def enthalpy_flow(state):
    return state['mass_flow_kg_s'] * state['enthalpy_kJ_kg']


def public_stream(state):
    return {
        'mass_flow_kg_s': state['mass_flow_kg_s'],
        'temperature_K': state['temperature_K'],
        'pressure_Pa': state['pressure_Pa'],
        'enthalpy_kJ_kg': state['enthalpy_kJ_kg'],
        'vapor_fraction': state['vapor_fraction'],
    }


def run(values, tool):
    add_feed(tool, 'FEED', values['feed_temperature_C'], values['pressure_kPa'],
             values['flow_kg_h'])
    for name in ('PREHEATED', 'TWO-PHASE', 'VAPOR', 'LIQUID'):
        tool('dwsim_stream_add_material', name=name)
    tool('dwsim_unitop_add', type='Heater', name='H-01')
    tool('dwsim_unitop_connect', unitop='H-01', feed_stream='FEED',
         product_stream='PREHEATED')
    preheat_properties = {
        'CalcMode': 'OutletTemperature',
        'OutletTemperature': values['preheat_temperature_C'] + 273.15,
        'DeltaP': 0,
        'Eficiencia': 100,
    }
    tool('dwsim_unitop_set', name='H-01', properties=preheat_properties)
    tool('dwsim_unitop_add', type='Heater', name='EV-01')
    tool('dwsim_unitop_connect', unitop='EV-01', feed_stream='PREHEATED',
         product_stream='TWO-PHASE')
    evaporation_properties = {
        'CalcMode': 'OutletVaporFraction',
        'OutletVaporFraction': values['vapor_percent'] / 100,
        'DeltaP': 0,
        'Eficiencia': 100,
    }
    tool('dwsim_unitop_set', name='EV-01', properties=evaporation_properties)
    tool('dwsim_unitop_add', type='Vessel', name='V-01')
    tool('dwsim_unitop_connect', unitop='V-01', feed_stream='TWO-PHASE', feed_port=0,
         product_stream='VAPOR', product_port=0)
    tool('dwsim_unitop_connect', unitop='V-01', product_stream='LIQUID', product_port=1)
    required = {'FEED', 'PREHEATED', 'TWO-PHASE', 'VAPOR', 'LIQUID', 'H-01', 'EV-01', 'V-01'}
    check, solved, vessel_unit = solve(tool, 'V-01', required)
    units = {
        'H-01': tool('dwsim_unitop_get_results', name='H-01'),
        'EV-01': tool('dwsim_unitop_get_results', name='EV-01'),
        'V-01': vessel_unit,
    }
    if any(not unit.get('calculated') for unit in units.values()):
        raise RuntimeError('串联流程设备未全部完成计算')
    streams = {name: stream_state(name, tool('dwsim_stream_get_results', name=name))
               for name in ('FEED', 'PREHEATED', 'TWO-PHASE', 'VAPOR', 'LIQUID')}
    feed, preheated, two_phase = streams['FEED'], streams['PREHEATED'], streams['TWO-PHASE']
    vapor, liquid = streams['VAPOR'], streams['LIQUID']
    if preheated['vapor_fraction'] > 1e-6:
        raise RuntimeError('预热出口出现汽相，未满足同压力泡点至少 2 °C 裕量')
    if abs(preheated['temperature_K'] - (values['preheat_temperature_C'] + 273.15)) > TEMPERATURE_TOLERANCE_C:
        raise RuntimeError('预热出口温度未达到目标')
    if any(abs(streams[name]['pressure_Pa'] / 1000 - values['pressure_kPa']) > PRESSURE_TOLERANCE_KPA
           for name in ('PREHEATED', 'TWO-PHASE')):
        raise RuntimeError('预热或蒸发段压力未保持零压降目标')
    target_vapor = values['vapor_percent'] / 100
    if abs(two_phase['vapor_fraction'] - target_vapor) > 1e-6:
        raise RuntimeError('蒸发器汽相分率未达到目标')
    if not 1e-6 < two_phase['vapor_fraction'] < 1 - 1e-6:
        raise RuntimeError('蒸发器未形成真实两相物流')
    if vapor['vapor_fraction'] < 0.999999 or liquid['vapor_fraction'] > 1e-6:
        raise RuntimeError('Vessel 气液出口相态不纯')
    tolerance = max(1e-6, values['flow_kg_h'] * 1e-8)
    preheat_mass = (feed['mass_flow_kg_s'] - preheated['mass_flow_kg_s']) * 3600
    evaporation_mass = (preheated['mass_flow_kg_s'] - two_phase['mass_flow_kg_s']) * 3600
    separation_mass = (two_phase['mass_flow_kg_s'] - vapor['mass_flow_kg_s'] - liquid['mass_flow_kg_s']) * 3600
    overall_mass = (feed['mass_flow_kg_s'] - vapor['mass_flow_kg_s'] - liquid['mass_flow_kg_s']) * 3600
    vapor_split = (vapor['mass_flow_kg_s'] - two_phase['mass_flow_kg_s'] * two_phase['vapor_fraction']) * 3600
    liquid_split = (liquid['mass_flow_kg_s'] - two_phase['mass_flow_kg_s'] * (1 - two_phase['vapor_fraction'])) * 3600
    preheat_duty = enthalpy_flow(preheated) - enthalpy_flow(feed)
    evaporation_duty = enthalpy_flow(two_phase) - enthalpy_flow(preheated)
    vessel_energy = enthalpy_flow(vapor) + enthalpy_flow(liquid) - enthalpy_flow(two_phase)
    vessel_energy_relative = abs(vessel_energy) / max(abs(enthalpy_flow(two_phase)), 1e-12)
    full_energy = ((enthalpy_flow(preheated) - enthalpy_flow(feed) - preheat_duty) +
                   (enthalpy_flow(two_phase) - enthalpy_flow(preheated) - evaporation_duty) +
                   vessel_energy)
    require_finite('P4派生结果', preheat_mass_residual_kg_h=preheat_mass,
                   evaporation_mass_residual_kg_h=evaporation_mass,
                   separation_mass_residual_kg_h=separation_mass,
                   overall_mass_residual_kg_h=overall_mass, vapor_split_residual_kg_h=vapor_split,
                   liquid_split_residual_kg_h=liquid_split, preheat_heat_duty_kW=preheat_duty,
                   evaporation_heat_duty_kW=evaporation_duty, vessel_energy_residual_kW=vessel_energy,
                   vessel_energy_residual_relative=vessel_energy_relative,
                   full_energy_residual_kW=full_energy)
    if max(abs(preheat_mass), abs(evaporation_mass), abs(separation_mass), abs(overall_mass),
           abs(vapor_split), abs(liquid_split)) > tolerance:
        raise RuntimeError('串联流程物料衡算或汽液分配未通过')
    if vessel_energy_relative > 1e-4:
        raise RuntimeError('Vessel 能量衡算未通过')
    results = {
        'preheat_heat_duty_kW': preheat_duty,
        'evaporation_heat_duty_kW': evaporation_duty,
        'vapor_product_kg_h': vapor['mass_flow_kg_s'] * 3600,
        'liquid_product_kg_h': liquid['mass_flow_kg_s'] * 3600,
        'preheated_temperature_C': preheated['temperature_K'] - 273.15,
        'two_phase_vapor_fraction': two_phase['vapor_fraction'],
        'vapor_product_vapor_fraction': vapor['vapor_fraction'],
        'liquid_product_vapor_fraction': liquid['vapor_fraction'],
        'preheat_mass_residual_kg_h': preheat_mass,
        'evaporation_mass_residual_kg_h': evaporation_mass,
        'separation_mass_residual_kg_h': separation_mass,
        'overall_mass_residual_kg_h': overall_mass,
        'vapor_split_residual_kg_h': vapor_split,
        'liquid_split_residual_kg_h': liquid_split,
        'vessel_energy_residual_kW': vessel_energy,
        'vessel_energy_residual_relative': vessel_energy_relative,
        'full_energy_residual_kW': full_energy,
    }
    return {
        'results': results,
        'comparison': {'metric': 'evaporation_heat_duty_kW', 'label': 'EV-01 蒸发热负荷',
                       'unit': 'kW', 'value': evaporation_duty},
        'raw': {
            'topology': 'FEED -> H-01 -> PREHEATED -> EV-01 -> TWO-PHASE -> V-01 -> VAPOR + LIQUID',
            'streams': {name: public_stream(state) for name, state in streams.items()},
            'units': {name: {'calculated': bool(unit.get('calculated'))} for name, unit in units.items()},
            'check': {'ready': bool(check.get('ready'))},
            'solve': {'ok': bool(solved.get('ok')), 'calculated_objects': sorted(required)},
            'applied': {'H-01': preheat_properties, 'EV-01': evaporation_properties},
        },
    }
