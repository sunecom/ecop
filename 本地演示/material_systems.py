"""Controlled P2 material-system and property-package flash workflow."""
import math

from basic_units import mixture, require_finite, solve, vapor_fraction


PROPERTY_PACKAGES = {
    'steam_tables': 'Steam Tables (IAPWS-IF97)',
    'nrtl': 'NRTL',
    'raoult': "Raoult's Law",
}

SYSTEMS = {
    'water': {
        'name': '纯水',
        'compounds': ('Water',),
        'packages': ('steam_tables',),
        'reference': {
            'temperature_K': 373.17,
            'pressure_kPa': 101.325,
            'source': 'NIST Chemistry WebBook SRD 69, Water, phase-change data',
            'url': 'https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185&Mask=4',
        },
    },
    'ethanol': {
        'name': '纯乙醇',
        'compounds': ('Ethanol',),
        'packages': ('nrtl', 'raoult'),
        'reference': {
            'temperature_K': 351.5,
            'pressure_kPa': 101.325,
            'source': 'NIST Chemistry WebBook SRD 69, Ethanol, phase-change data',
            'url': 'https://webbook.nist.gov/cgi/cbook.cgi?ID=C64175&Mask=4',
        },
    },
    'acetone': {
        'name': '纯丙酮',
        'compounds': ('Acetone',),
        'packages': ('nrtl', 'raoult'),
        'reference': {
            'temperature_K': 329.3,
            'pressure_kPa': 101.325,
            'source': 'NIST Chemistry WebBook SRD 69, Acetone, phase-change data',
            'url': 'https://webbook.nist.gov/cgi/cbook.cgi?ID=C67641&Mask=4',
        },
    },
    'water_ethanol': {
        'name': '水–乙醇二元混合物',
        'compounds': ('Water', 'Ethanol'),
        'packages': ('nrtl', 'raoult'),
    },
}

DEFINITIONS = {
    'material_flash': {
        'name': '受控物系目标汽相闪蒸', 'unit_type': 'Heater', 'unit_name': 'FLASH-P2'},
}

MASS_FRACTION_TOLERANCE = 1e-8
MASS_FLOW_TOLERANCE_KG_H = 1e-6
PRESSURE_TOLERANCE_KPA = 0.02
VAPOR_FRACTION_TOLERANCE = 1e-5
PHASE_BALANCE_RELATIVE_TOLERANCE = 2e-5


def validate(data, number):
    if data.get('module') != 'material_flash':
        return None
    system_id = {0: 'water', 1: 'ethanol', 2: 'acetone', 3: 'water_ethanol'}.get(
        data.get('system'), data.get('system'))
    package_id = {0: 'steam_tables', 1: 'nrtl', 2: 'raoult'}.get(
        data.get('property_package'), data.get('property_package'))
    if system_id not in SYSTEMS:
        raise ValueError('当前仅开放 Water、Ethanol、Acetone 与 Water–Ethanol 受控物系')
    system = SYSTEMS[system_id]
    if package_id not in PROPERTY_PACKAGES or package_id not in system['packages']:
        raise ValueError('所选物性包不适用于当前受控物系')
    values = {
        'module': 'material_flash',
        'system': system_id,
        'system_name': system['name'],
        'property_package_id': package_id,
        'property_package': PROPERTY_PACKAGES[package_id],
        'flow_kg_h': number(data, 'flow_kg_h', '总质量流量', 10, 100000),
        'inlet_temperature_C': number(data, 'inlet_temperature_C', '入口温度', 5, 60),
        'pressure_kPa': number(data, 'pressure_kPa', '绝对压力', 80, 500),
        'vapor_molar_percent': number(
            data, 'vapor_molar_percent', '目标汽相摩尔百分数', 5, 95),
        'composition_basis': 'mass_fraction',
    }
    if system_id == 'water_ethanol':
        ethanol_percent = number(
            data, 'ethanol_mass_percent', '乙醇质量百分数', 5, 95)
        values['ethanol_mass_percent'] = ethanol_percent
        values['composition'] = {
            'Water': (100 - ethanol_percent) / 100,
            'Ethanol': ethanol_percent / 100,
        }
    else:
        compound = system['compounds'][0]
        values['composition'] = {compound: 1.0}
    values['compounds'] = list(system['compounds'])
    return values


def phase(stream, name):
    return next(item for item in stream.get('phases', []) if item.get('name') == name)


def mass_fractions(stream, phase_name='Mixture'):
    compounds = phase(stream, phase_name).get('compounds', {})
    return {name: float(values['mass_fraction']) for name, values in compounds.items()}


def require_composition(label, actual, expected):
    if set(actual) != set(expected):
        raise RuntimeError(f'{label}组分集合与输入不一致')
    require_finite(label + '组成', **actual)
    if abs(sum(actual.values()) - 1) > MASS_FRACTION_TOLERANCE:
        raise RuntimeError(f'{label}质量分数总和不为 1')
    if max(abs(actual[name] - expected[name]) for name in expected) > MASS_FRACTION_TOLERANCE:
        raise RuntimeError(f'{label}质量分数与输入不一致')


def mole_fractions(stream, phase_name='Mixture'):
    compounds = phase(stream, phase_name).get('compounds', {})
    return {name: float(values['mole_fraction']) for name, values in compounds.items()}


def phase_balance(feed, product, compounds):
    product_mass_flow = float(product['mass_flow_kg_s'])
    product_molar_flow = float(product['molar_flow_mol_s'])
    feed_mass_flow = float(feed['mass_flow_kg_s'])
    feed_molar_flow = float(feed['molar_flow_mol_s'])
    overall_mass = mass_fractions(product)
    overall_mole = mole_fractions(product)
    feed_mass = mass_fractions(feed)
    feed_mole = mole_fractions(feed)
    require_finite('总摩尔流量', feed_molar_flow=feed_molar_flow,
                   product_molar_flow=product_molar_flow)
    if min(feed_molar_flow, product_molar_flow) <= 0:
        raise RuntimeError('引擎未返回有效总摩尔流量')
    average_mw_g_mol = product_mass_flow / product_molar_flow * 1000
    molecular_weights = {}
    for compound in compounds:
        if overall_mole[compound] <= 0:
            raise RuntimeError('整体摩尔组成不能用于相流量换算')
        molecular_weights[compound] = (
            overall_mass[compound] / overall_mole[compound] * average_mw_g_mol)

    active = {}
    phase_component_mass_kg_h = {name: 0.0 for name in compounds}
    phase_component_molar_mol_h = {name: 0.0 for name in compounds}
    phase_mass_total_kg_h = 0.0
    phase_molar_total_mol_h = 0.0
    for phase_name in ('OverallLiquid', 'Vapor'):
        current = phase(product, phase_name)
        molar_fraction = float(current.get('fraction', 0))
        if molar_fraction <= VAPOR_FRACTION_TOLERANCE:
            continue
        mass = mass_fractions(product, phase_name)
        mole = mole_fractions(product, phase_name)
        require_finite(phase_name + '组成', **mass, **{
            f'mole_{name}': value for name, value in mole.items()})
        if abs(sum(mass.values()) - 1) > MASS_FRACTION_TOLERANCE:
            raise RuntimeError(f'{phase_name}活跃相质量分数总和不为 1')
        if abs(sum(mole.values()) - 1) > MASS_FRACTION_TOLERANCE:
            raise RuntimeError(f'{phase_name}活跃相摩尔分数总和不为 1')
        phase_molar_flow = product_molar_flow * molar_fraction
        component_mass = {}
        component_molar = {}
        for compound in compounds:
            component_molar[compound] = phase_molar_flow * mole[compound] * 3600
            component_mass[compound] = (
                phase_molar_flow * mole[compound] * molecular_weights[compound]
                / 1000 * 3600)
            phase_component_molar_mol_h[compound] += component_molar[compound]
            phase_component_mass_kg_h[compound] += component_mass[compound]
        phase_mass_flow = sum(component_mass.values())
        derived_mass = {name: component_mass[name] / phase_mass_flow
                        for name in compounds}
        if max(abs(derived_mass[name] - mass[name]) for name in compounds) > 1e-7:
            raise RuntimeError(f'{phase_name}质量/摩尔组成换算不一致')
        phase_mass_total_kg_h += phase_mass_flow
        phase_molar_total_mol_h += phase_molar_flow * 3600
        active[phase_name] = {
            'phase_molar_fraction': molar_fraction,
            'phase_molar_flow_mol_h': phase_molar_flow * 3600,
            'phase_mass_flow_kg_h': phase_mass_flow,
            'phase_mass_fraction': phase_mass_flow / (product_mass_flow * 3600),
            'mass_fractions': mass,
            'mole_fractions': mole,
            'component_mass_flows_kg_h': component_mass,
            'component_molar_flows_mol_h': component_molar,
        }

    phase_molar_fraction_sum = sum(
        item['phase_molar_fraction'] for item in active.values())
    if abs(phase_molar_fraction_sum - 1) > VAPOR_FRACTION_TOLERANCE:
        raise RuntimeError('汽液相摩尔相率总和不为 1')
    feed_component_mass = {
        name: feed_mass_flow * 3600 * feed_mass[name] for name in compounds}
    feed_component_molar = {
        name: feed_molar_flow * 3600 * feed_mole[name] for name in compounds}
    mass_residuals = {
        name: feed_component_mass[name] - phase_component_mass_kg_h[name]
        for name in compounds}
    molar_residuals = {
        name: feed_component_molar[name] - phase_component_molar_mol_h[name]
        for name in compounds}
    phase_mass_residual = product_mass_flow * 3600 - phase_mass_total_kg_h
    phase_molar_residual = product_molar_flow * 3600 - phase_molar_total_mol_h
    require_finite('相分配衡算', phase_mass_residual=phase_mass_residual,
                   phase_molar_residual=phase_molar_residual, **{
                       f'mass_{name}': value for name, value in mass_residuals.items()}, **{
                       f'molar_{name}': value for name, value in molar_residuals.items()})
    phase_mass_tolerance = max(
        MASS_FLOW_TOLERANCE_KG_H,
        product_mass_flow * 3600 * PHASE_BALANCE_RELATIVE_TOLERANCE)
    phase_molar_tolerance = max(
        1e-5, product_molar_flow * 3600 * PHASE_BALANCE_RELATIVE_TOLERANCE)
    if abs(phase_mass_residual) > phase_mass_tolerance or \
            max(abs(value) for value in mass_residuals.values()) > phase_mass_tolerance:
        raise RuntimeError('汽液相重组分组分质量衡算未通过')
    if abs(phase_molar_residual) > phase_molar_tolerance or \
            max(abs(value) for value in molar_residuals.values()) > phase_molar_tolerance:
        raise RuntimeError('汽液相重组分组分摩尔衡算未通过')
    return {
        'phase_fraction_basis': 'molar',
        'active_phases': active,
        'molecular_weights_g_mol_derived': molecular_weights,
        'phase_mass_residual_kg_h': phase_mass_residual,
        'phase_molar_residual_mol_h': phase_molar_residual,
        'phase_mass_tolerance_kg_h': phase_mass_tolerance,
        'phase_molar_tolerance_mol_h': phase_molar_tolerance,
        'component_phase_mass_residuals_kg_h': mass_residuals,
        'component_phase_molar_residuals_mol_h': molar_residuals,
    }


def run(values, tool):
    compounds_applied = tool('dwsim_thermo_add_compounds', names=values['compounds'])
    if set(compounds_applied.get('added', [])) != set(values['compounds']):
        raise RuntimeError('组分设置后回读不一致')
    package_applied = tool(
        'dwsim_thermo_set_property_package', name=values['property_package'])
    if package_applied.get('property_package') != values['property_package']:
        raise RuntimeError('物性包设置后回读不一致')

    requested_flow = values['flow_kg_h'] / 3600
    tool('dwsim_stream_add_material', name='FEED',
         temperature_K=values['inlet_temperature_C'] + 273.15,
         pressure_Pa=values['pressure_kPa'] * 1000,
         mass_flow_kg_s=requested_flow, composition=values['composition'])
    tool('dwsim_stream_set_conditions', name='FEED', mass_flow_kg_s=requested_flow)
    feed_readback = tool('dwsim_stream_get_results', name='FEED')
    feed_composition = mass_fractions(feed_readback)
    require_composition('入口回读', feed_composition, values['composition'])
    feed_flow_residual = (feed_readback['mass_flow_kg_s'] - requested_flow) * 3600
    require_finite('入口回读', mass_flow=feed_readback.get('mass_flow_kg_s'),
                   temperature=feed_readback.get('temperature_K'),
                   pressure=feed_readback.get('pressure_Pa'),
                   mass_flow_residual=feed_flow_residual)
    if abs(feed_flow_residual) > MASS_FLOW_TOLERANCE_KG_H:
        raise RuntimeError('设置组成后总质量流量回读不一致')

    tool('dwsim_stream_add_material', name='PRODUCT')
    tool('dwsim_unitop_add', type='Heater', name='FLASH-P2')
    tool('dwsim_unitop_connect', unitop='FLASH-P2', feed_stream='FEED',
         product_stream='PRODUCT')
    applied = tool('dwsim_unitop_set', name='FLASH-P2', properties={
        'CalcMode': 'OutletVaporFraction',
        'OutletVaporFraction': values['vapor_molar_percent'] / 100,
        'DeltaP': 0,
        'Eficiencia': 100,
    })
    check, solved, unit = solve(tool, 'FLASH-P2', {'FEED', 'PRODUCT', 'FLASH-P2'})
    feed = tool('dwsim_stream_get_results', name='FEED')
    product = tool('dwsim_stream_get_results', name='PRODUCT')
    product_composition = mass_fractions(product)
    require_composition('出口整体', product_composition, values['composition'])
    phase_distribution = phase_balance(feed, product, values['compounds'])

    feed_flow = feed['mass_flow_kg_s'] * 3600
    product_flow = product['mass_flow_kg_s'] * 3600
    mass_residual = feed_flow - product_flow
    component_residuals = {
        compound: feed_flow * feed_composition[compound] -
        product_flow * product_composition[compound]
        for compound in values['compounds']
    }
    max_component_residual = max(abs(value) for value in component_residuals.values())
    outlet_pressure = product['pressure_Pa'] / 1000
    outlet_vapor = vapor_fraction(product)
    heat_duty = product['mass_flow_kg_s'] * (
        mixture(product)['enthalpy_kJ_kg'] - mixture(feed)['enthalpy_kJ_kg'])
    results = {
        'outlet_temperature_C': product['temperature_K'] - 273.15,
        'outlet_pressure_kPa': outlet_pressure,
        'outlet_vapor_molar_fraction': outlet_vapor,
        'vapor_phase_mass_fraction': phase_distribution['active_phases']['Vapor'][
            'phase_mass_fraction'],
        'heat_duty_kW': heat_duty,
        'feed_flow_readback_kg_h': feed_flow,
        'product_flow_kg_h': product_flow,
        'mass_residual_kg_h': mass_residual,
        'max_overall_component_mass_residual_kg_h': max_component_residual,
        'max_phase_component_mass_residual_kg_h': max(abs(value) for value in
            phase_distribution['component_phase_mass_residuals_kg_h'].values()),
        'max_phase_component_molar_residual_mol_h': max(abs(value) for value in
            phase_distribution['component_phase_molar_residuals_mol_h'].values()),
        'feed_mass_fraction_sum': sum(feed_composition.values()),
        'product_mass_fraction_sum': sum(product_composition.values()),
    }
    reference = SYSTEMS[values['system']].get('reference')
    reference_comparison = None
    if (reference is not None and
            abs(values['pressure_kPa'] - reference['pressure_kPa']) <= 1e-6):
        reference_temperature_C = reference['temperature_K'] - 273.15
        results['reference_normal_boiling_temperature_C'] = reference_temperature_C
        results['reference_temperature_delta_C'] = (
            results['outlet_temperature_C'] - reference_temperature_C)
        reference_comparison = {
            **reference,
            'comparison_kind': 'external_reference_screen',
            'calculated_condition': {
                'pressure_kPa_absolute': values['pressure_kPa'],
                'outlet_vapor_molar_fraction': outlet_vapor,
            },
            'note': ('纯物质两相平衡温度与汽相摩尔率规格无关；该对照仅验证量级，'
                     '不代表物性包精度认证，也不设置未经来源支持的硬容差。'),
        }
    require_finite('物系闪蒸结果', **results, **{
        f'component_{name}': value for name, value in component_residuals.items()})
    if abs(mass_residual) > MASS_FLOW_TOLERANCE_KG_H or \
            max_component_residual > MASS_FLOW_TOLERANCE_KG_H:
        raise RuntimeError('总质量或分组分质量衡算未通过')
    if abs(outlet_pressure - values['pressure_kPa']) > PRESSURE_TOLERANCE_KPA:
        raise RuntimeError('物系闪蒸出口压力未达到目标')
    if abs(outlet_vapor - values['vapor_molar_percent'] / 100) > VAPOR_FRACTION_TOLERANCE:
        raise RuntimeError('物系闪蒸汽相摩尔比例未达到目标')

    return {
        'results': results,
        'comparison': {'metric': 'outlet_temperature_C', 'label': '闪蒸温度',
                       'unit': '°C', 'value': results['outlet_temperature_C']},
        'material_system': {
            'id': values['system'],
            'name': values['system_name'],
            'composition_basis': 'mass_fraction',
            'requested_mass_fractions': values['composition'],
            'feed_mass_fractions': feed_composition,
            'product_mass_fractions': product_composition,
            'phase_fraction_basis': 'molar',
            'active_phase_compositions': phase_distribution['active_phases'],
            'overall_component_mass_residuals_kg_h': component_residuals,
            'phase_distribution_balance': phase_distribution,
            'reference_comparison': reference_comparison,
            'verification_level': ('L2-engine-consistency; external reference is a '
                                   'screen only, not physical-property accuracy certification'),
        },
        'raw': {
            'feed_readback_before_solve': feed_readback,
            'feed': feed,
            'product': product,
            'unit': unit,
            'check': check,
            'solve': solved,
            'applied': applied,
            'property_package_applied': package_applied,
            'compounds_applied': compounds_applied,
        },
    }
