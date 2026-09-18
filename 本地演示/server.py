from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import json, math, threading, time, uuid, secrets, os
import advanced_units, basic_units, catalog, material_systems

BASE = Path(__file__).resolve().parent
PORT = 18765
MCP = os.environ.get('DWSIM_MCP_URL', 'http://localhost:15901/mcp')
TOKEN = Path(os.environ.get('DWSIM_TOKEN_FILE', str(BASE.parent / '.local/mcp-token.txt'))).read_text().strip()
RUNS = Path(os.environ.get('ECOP_RUNS_DIR', str(BASE / 'runs')))
MODEL_DIR = os.environ.get('DWSIM_MODEL_DIR', '/models')
NONCE = secrets.token_urlsafe(24)
LOCK = threading.Lock()
SHA = os.environ.get('DWSIM_BUILD_REFERENCE', '0cd6a30ce1b5eb976cdd94495d102a9691b067f5')
SOURCE_PIN = '0cd6a30ce1b5eb976cdd94495d102a9691b067f5'
CATALOG_CACHE = None
COMPOUND_CACHE = []


def rpc(method, params=None):
    data = json.dumps({'jsonrpc': '2.0', 'id': uuid.uuid4().hex,
                       'method': method, 'params': params or {}}).encode()
    req = Request(MCP, data, {'Content-Type': 'application/json', 'X-MCP-Token': TOKEN})
    with urlopen(req, timeout=90) as response:
        body = json.load(response)
    if 'error' in body:
        raise RuntimeError(str(body['error']))
    return body['result']


def call(tool_name, **args):
    result = rpc('tools/call', {'name': tool_name, 'arguments': args})
    if result.get('isError'):
        raise RuntimeError(str(result.get('content')))
    return json.loads(next(item['text'] for item in result['content'] if item['type'] == 'text'))


def number(data, name, label, low, high):
    value = data.get(name)
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f'{label}必须为有效数字')
    if not low <= value <= high:
        raise ValueError(f'{label}必须在 {low} 至 {high} 之间')
    return float(value)


def validate(data):
    if not isinstance(data, dict):
        raise ValueError('请求必须为 JSON 对象')
    module = data.get('module', 'evaporation')
    if module == 'evaporation':
        return {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '进料流量', 10, 100000),
            'temperature_C': number(data, 'temperature_C', '入口温度', 5, 80),
            'pressure_kPa': number(data, 'pressure_kPa', '运行绝对压力', 60, 300),
            'vapor_percent': number(data, 'vapor_percent', '目标汽化比例', 1, 95),
        }
    if module == 'temperature':
        values = {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '进料流量', 10, 100000),
            'inlet_temperature_C': number(data, 'inlet_temperature_C', '入口温度', 5, 90),
            'pressure_kPa': number(data, 'pressure_kPa', '运行绝对压力', 100, 2000),
            'outlet_temperature_C': number(data, 'outlet_temperature_C', '目标出口温度', 5, 90),
        }
        if math.isclose(values['inlet_temperature_C'], values['outlet_temperature_C'], abs_tol=0.01):
            raise ValueError('目标出口温度必须与入口温度至少相差 0.01 °C')
        return values
    if module == 'pump':
        values = {
            'module': module,
            'flow_kg_h': number(data, 'flow_kg_h', '进料流量', 10, 100000),
            'inlet_temperature_C': number(data, 'inlet_temperature_C', '入口温度', 5, 80),
            'inlet_pressure_kPa': number(data, 'inlet_pressure_kPa', '入口绝对压力', 100, 2000),
            'outlet_pressure_kPa': number(data, 'outlet_pressure_kPa', '出口绝对压力', 200, 10000),
            'efficiency_percent': number(data, 'efficiency_percent', '泵效率', 20, 95),
        }
        if values['outlet_pressure_kPa'] - values['inlet_pressure_kPa'] < 10:
            raise ValueError('出口压力必须比入口压力至少高 10 kPa')
        return values
    basic_values = basic_units.validate(data, number)
    if basic_values is not None:
        return basic_values
    advanced_values = advanced_units.validate(data, number)
    if advanced_values is not None:
        return advanced_values
    material_values = material_systems.validate(data, number)
    if material_values is not None:
        return material_values
    raise ValueError('不支持的计算模块')


def project_inputs(data):
    values = validate(data)
    if values['module'] != 'material_flash':
        return values
    keys = ('module', 'system', 'flow_kg_h', 'inlet_temperature_C', 'pressure_kPa',
            'vapor_molar_percent', 'ethanol_mass_percent')
    replayable = {key: values[key] for key in keys if key in values}
    replayable['property_package'] = values['property_package_id']
    return replayable


def get_catalog():
    global CATALOG_CACHE, COMPOUND_CACHE
    if CATALOG_CACHE is not None:
        return CATALOG_CACHE
    if not LOCK.acquire(blocking=False):
        raise ValueError('引擎正在执行计算，请稍后刷新模块目录')
    flowsheet_id = None
    try:
        tools = rpc('tools/list')['tools']
        flowsheet_id = call('dwsim_flowsheet_create', name='ECOP capability inventory')['flowsheet_id']
        unit_types = call('dwsim_unitop_list_types', flowsheet_id=flowsheet_id)['types']
        packages = call('dwsim_thermo_list_property_packages', flowsheet_id=flowsheet_id)['property_packages']
        compounds = call('dwsim_thermo_list_compounds', flowsheet_id=flowsheet_id)
        COMPOUND_CACHE = [name for name in compounds.get('compounds', []) if name]
        grouped = {group['id']: [] for group in catalog.TOOL_GROUPS}
        tool_records = []
        for tool in tools:
            group_id = catalog.tool_group(tool['name'])
            record = {'name': tool['name'], 'description': tool.get('description', ''), 'group': group_id}
            grouped[group_id].append(record)
            tool_records.append(record)
        tool_groups = [{**group, 'count': len(grouped[group['id']]),
                        'tools': [item['name'] for item in grouped[group['id']]]}
                       for group in catalog.TOOL_GROUPS]
        CATALOG_CACHE = {
            'ok': True,
            'engine': 'DWSIM 10.2.8',
            'build': SHA,
            'source_pin': SOURCE_PIN,
            'captured_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'counts': {
                'mcp_tools': len(tools),
                'unit_operations': len(unit_types),
                'property_packages': len(packages),
                'compounds': compounds.get('count', len(COMPOUND_CACHE)),
                'live_workflows': 10,
            },
            'tool_groups': tool_groups,
            'mcp_tools': tool_records,
            'unit_groups': catalog.build_unit_groups(unit_types),
            'property_packages': packages,
            'platform_modules': catalog.PLATFORM_MODULES,
            'desktop_modules': catalog.DESKTOP_MODULES,
            'status_legend': catalog.STATUS_LEGEND,
        }
        return CATALOG_CACHE
    finally:
        if flowsheet_id:
            try:
                call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id)
            except Exception:
                pass
        LOCK.release()


def search_compounds(query, limit=20):
    if CATALOG_CACHE is None:
        get_catalog()
    query = query.strip()
    if len(query) < 2:
        raise ValueError('请输入至少 2 个字符搜索组分')
    if len(query) > 64:
        raise ValueError('组分搜索词过长')
    lowered = query.casefold()
    matches = [name for name in COMPOUND_CACHE if lowered in name.casefold()]
    matches.sort(key=lambda name: (not name.casefold().startswith(lowered), len(name), name.casefold()))
    return {'ok': True, 'query': query, 'matches': matches[:limit],
            'match_count': len(matches), 'limit': limit}


def mixture(stream):
    return next(phase for phase in stream['phases']
                if phase['name'].lower() in ('mixture', 'overall'))


def vapor_fraction(stream):
    return next(phase['fraction'] for phase in stream['phases']
                if phase['name'].lower() == 'vapor')


def strict_json_text(data, indent=None):
    try:
        return json.dumps(data, ensure_ascii=False, allow_nan=False, indent=indent)
    except (TypeError, ValueError) as exc:
        raise RuntimeError('计算结果包含不可序列化或非有限数值') from exc


def strict_json_bytes(data):
    return strict_json_text(data).encode()


def save_result(result):
    serialized = strict_json_text(result, indent=2)
    RUNS.mkdir(parents=True, exist_ok=True)
    (RUNS / (result['run_id'] + '.json')).write_text(
        serialized, encoding='utf-8')


def calculate(data, export_path=None):
    values = validate(data)
    if not LOCK.acquire(blocking=False):
        raise ValueError('已有计算正在进行，请稍后再试')
    flowsheet_id = None
    try:
        started = time.monotonic()
        module = values['module']
        special_definitions = {
            **basic_units.DEFINITIONS,
            **advanced_units.DEFINITIONS,
            **material_systems.DEFINITIONS,
        }
        if module in special_definitions:
            definition = special_definitions[module]
            module_name = definition['name']
            unit_type = definition['unit_type']
            unit_name = definition['unit_name']
            inlet_temperature = inlet_pressure = None
        elif module == 'evaporation':
            module_name, unit_type, unit_name = '目标汽化计算', 'Heater', 'EV-01'
            inlet_temperature, inlet_pressure = values['temperature_C'], values['pressure_kPa']
        elif module == 'temperature':
            module_name, unit_type, unit_name = '出口温度计算', None, 'HX-01'
            inlet_temperature, inlet_pressure = values['inlet_temperature_C'], values['pressure_kPa']
            unit_type = 'Heater' if values['outlet_temperature_C'] > inlet_temperature else 'Cooler'
        else:
            module_name, unit_type, unit_name = '纯水泵升压', 'Pump', 'P-01'
            inlet_temperature, inlet_pressure = values['inlet_temperature_C'], values['inlet_pressure_kPa']

        if module == 'material_flash':
            flowsheet_id = call(
                'dwsim_flowsheet_load',
                filepath=material_systems.template_path(values, MODEL_DIR))['flowsheet_id']
        else:
            flowsheet_id = call(
                'dwsim_flowsheet_create', name='ECOP ' + module_name)['flowsheet_id']

        def tool(tool_name, **kwargs):
            return call(tool_name, flowsheet_id=flowsheet_id, **kwargs)

        def save_export():
            if export_path is None:
                return
            path = Path(export_path)
            if not path.is_absolute() or path.suffix.lower() != '.dwxml':
                raise RuntimeError('DWSIM 导出路径无效')
            saved = tool('dwsim_flowsheet_save', filepath=str(path), compressed=False)
            saved_path = Path(saved.get('saved', '')).resolve()
            if saved_path != path.resolve() or not path.is_file() or path.stat().st_size <= 0:
                raise RuntimeError('DWSIM 流程文件保存失败')

        if module != 'material_flash':
            tool('dwsim_thermo_add_compounds', names=['Water'])
        packages = tool('dwsim_thermo_list_property_packages')['property_packages']
        property_package = (values['property_package'] if module == 'material_flash'
                            else next(name for name in packages if 'Steam' in name))
        if property_package not in packages:
            raise RuntimeError('请求的物性包不在当前引擎库存中')
        if module != 'material_flash':
            tool('dwsim_thermo_set_property_package', name=property_package)

        if module in special_definitions:
            if module in basic_units.DEFINITIONS:
                workflow = basic_units.run(values, tool)
            elif module in advanced_units.DEFINITIONS:
                workflow = advanced_units.run(values, tool)
            else:
                workflow = material_systems.run(values, tool)
            result = {
                'run_id': uuid.uuid4().hex,
                'time': time.strftime('%Y-%m-%d %H:%M:%S'),
                'module': {'id': module, 'name': module_name, 'unit_operation': unit_type,
                           'unit_tag': unit_name},
                'inputs': values,
                'engine': 'DWSIM 10.2.8',
                'commit': SHA,
                'property_package': property_package,
                'elapsed_s': round(time.monotonic() - started, 2),
                'results': workflow['results'],
                'comparison': workflow['comparison'],
                'raw': workflow['raw'],
            }
            if 'material_system' in workflow:
                result['material_system'] = workflow['material_system']
            save_export()
            save_result(result)
            return result

        tool('dwsim_stream_add_material', name='FEED', temperature_K=inlet_temperature + 273.15,
             pressure_Pa=inlet_pressure * 1000, mass_flow_kg_s=values['flow_kg_h'] / 3600,
             composition={'Water': 1.0})
        # The pinned MCP implementation treats composition values as compound mass flows.
        # Reapply total flow after composition so the requested basis remains authoritative.
        tool('dwsim_stream_set_conditions', name='FEED', mass_flow_kg_s=values['flow_kg_h'] / 3600)
        actual_flow = tool('dwsim_stream_get_results', name='FEED')['mass_flow_kg_s']
        if not math.isclose(actual_flow, values['flow_kg_h'] / 3600, rel_tol=1e-8):
            raise RuntimeError('引擎进料流量与输入不一致')
        tool('dwsim_stream_add_material', name='PRODUCT')
        tool('dwsim_unitop_add', type=unit_type, name=unit_name)
        tool('dwsim_unitop_connect', unitop=unit_name, feed_stream='FEED', product_stream='PRODUCT')

        if module == 'evaporation':
            properties = {'CalcMode': 'OutletVaporFraction',
                          'OutletVaporFraction': values['vapor_percent'] / 100,
                          'DeltaP': 0, 'Eficiencia': 100}
        elif module == 'temperature':
            properties = {'CalcMode': 'OutletTemperature',
                          'OutletTemperature': values['outlet_temperature_C'] + 273.15,
                          'DeltaP': 0, 'Eficiencia': 100}
        else:
            properties = {'CalcMode': 'OutletPressure',
                          'Pout': values['outlet_pressure_kPa'] * 1000,
                          'Eficiencia': values['efficiency_percent']}

        applied = tool('dwsim_unitop_set', name=unit_name, properties=properties)
        check = tool('dwsim_flowsheet_check')
        if not check.get('ready'):
            raise RuntimeError('流程预检查未通过')
        solved = tool('dwsim_solve_run', timeout_s=60)
        if not solved.get('ok'):
            raise RuntimeError(json.dumps(solved, ensure_ascii=False))
        required = {'FEED', 'PRODUCT', unit_name}
        if any(not item['calculated'] for item in solved['objects'] if item['name'] in required):
            raise RuntimeError('计算对象尚未全部完成')

        feed = tool('dwsim_stream_get_results', name='FEED')
        product = tool('dwsim_stream_get_results', name='PRODUCT')
        unit = tool('dwsim_unitop_get_results', name=unit_name)
        feed_mix, product_mix = mixture(feed), mixture(product)
        outlet_vapor_fraction = vapor_fraction(product)
        mass_residual = (feed['mass_flow_kg_s'] - product['mass_flow_kg_s']) * 3600
        heat_transfer = product['mass_flow_kg_s'] * (
            product_mix['enthalpy_kJ_kg'] - feed_mix['enthalpy_kJ_kg'])

        common = {
            'outlet_temperature_C': product['temperature_K'] - 273.15,
            'outlet_pressure_kPa': product['pressure_Pa'] / 1000,
            'outlet_vapor_fraction': outlet_vapor_fraction,
            'mass_residual_kg_h': mass_residual,
        }
        if abs(mass_residual) > max(1e-6, values['flow_kg_h'] * 1e-8):
            raise RuntimeError('物料衡算未通过')

        if module == 'evaporation':
            if not math.isclose(outlet_vapor_fraction, values['vapor_percent'] / 100, abs_tol=1e-5):
                raise RuntimeError('引擎汽化比例未达到目标')
            results = {**common, 'heat_duty_kW': heat_transfer,
                       'vapor_kg_h': product['mass_flow_kg_s'] * outlet_vapor_fraction * 3600,
                       'liquid_kg_h': product['mass_flow_kg_s'] * (1 - outlet_vapor_fraction) * 3600,
                       'vapor_fraction': outlet_vapor_fraction}
            comparison = {'metric': 'heat_duty_kW', 'label': '热负荷', 'unit': 'kW',
                          'value': heat_transfer}
        elif module == 'temperature':
            if abs(common['outlet_temperature_C'] - values['outlet_temperature_C']) > 0.02:
                raise RuntimeError('引擎出口温度未达到目标')
            if outlet_vapor_fraction > 1e-6:
                raise RuntimeError('工况产生汽相，超出当前单液相温控模块边界')
            results = {**common, 'heat_duty_kW': heat_transfer,
                       'absolute_heat_duty_kW': abs(heat_transfer),
                       'temperature_change_C': common['outlet_temperature_C'] - inlet_temperature,
                       'operation': 'heating' if heat_transfer > 0 else 'cooling'}
            comparison = {'metric': 'heat_duty_kW', 'label': '介质净吸热', 'unit': 'kW',
                          'value': heat_transfer}
        else:
            if abs(common['outlet_pressure_kPa'] - values['outlet_pressure_kPa']) > 0.02:
                raise RuntimeError('引擎出口压力未达到目标')
            if outlet_vapor_fraction > 1e-6:
                raise RuntimeError('泵入口或出口并非单液相，超出当前模块边界')
            shaft_power = heat_transfer
            if shaft_power <= 0:
                raise RuntimeError('泵轴功率结果无效')
            pressure_rise = common['outlet_pressure_kPa'] - values['inlet_pressure_kPa']
            hydraulic_power = pressure_rise * (feed['mass_flow_kg_s'] / feed_mix['density_kg_m3'])
            results = {**common, 'shaft_power_kW': shaft_power,
                       'hydraulic_power_kW': hydraulic_power,
                       'pressure_rise_kPa': pressure_rise,
                       'temperature_rise_C': common['outlet_temperature_C'] - inlet_temperature,
                       'inlet_density_kg_m3': feed_mix['density_kg_m3'],
                       'calculated_efficiency_percent': hydraulic_power / shaft_power * 100}
            comparison = {'metric': 'shaft_power_kW', 'label': '轴功率', 'unit': 'kW',
                          'value': shaft_power}

        result = {
            'run_id': uuid.uuid4().hex,
            'time': time.strftime('%Y-%m-%d %H:%M:%S'),
            'module': {'id': module, 'name': module_name, 'unit_operation': unit_type},
            'inputs': values,
            'engine': 'DWSIM 10.2.8',
            'commit': SHA,
            'property_package': property_package,
            'elapsed_s': round(time.monotonic() - started, 2),
            'results': results,
            'comparison': comparison,
            'raw': {'feed': feed, 'product': product, 'unit': unit,
                    'check': check, 'solve': solved, 'applied': applied},
        }
        save_export()
        save_result(result)
        return result
    finally:
        if flowsheet_id:
            try:
                call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id)
            except Exception:
                pass
        LOCK.release()


class Handler(BaseHTTPRequestHandler):
    def send(self, status, data, content_type='application/json; charset=utf-8'):
        if not isinstance(data, bytes):
            data = strict_json_bytes(data)
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/':
            self.send(200, (BASE / 'index.html').read_text(encoding='utf-8')
                      .replace('__NONCE__', NONCE).encode(), 'text/html; charset=utf-8')
        elif parsed.path == '/logo.png':
            self.send(200, (BASE / 'logo.png').read_bytes(), 'image/png')
        elif parsed.path == '/ecop-logo.jpg':
            self.send(200, (BASE / 'ecop-logo.jpg').read_bytes(), 'image/jpeg')
        elif parsed.path == '/project_ui.js':
            self.send(200, (BASE / 'project_ui.js').read_bytes(),
                      'application/javascript; charset=utf-8')
        elif parsed.path == '/api/status':
            try:
                tools = rpc('tools/list')['tools']
                self.send(200, {'ok': True, 'tools': len(tools),
                                'engine': 'DWSIM 10.2.8', 'commit': SHA})
            except Exception as exc:
                self.send(503, {'ok': False, 'error': str(exc)})
        elif parsed.path == '/api/catalog':
            try:
                self.send(200, get_catalog())
            except ValueError as exc:
                self.send(409, {'ok': False, 'error': str(exc)})
            except Exception as exc:
                self.send(503, {'ok': False, 'error': str(exc)})
        elif parsed.path == '/api/compounds':
            try:
                query = parse_qs(parsed.query).get('q', [''])[0]
                self.send(200, search_compounds(query))
            except ValueError as exc:
                self.send(400, {'ok': False, 'error': str(exc)})
            except Exception as exc:
                self.send(503, {'ok': False, 'error': str(exc)})
        else:
            self.send(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/api/calculate':
            return self.send(404, {'error': 'Not found'})
        if self.headers.get('X-Demo-Token') != NONCE:
            return self.send(403, {'error': '请刷新本地页面后重试'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length < 4096:
                raise ValueError('请求大小不正确')
            self.send(200, calculate(json.loads(self.rfile.read(length))))
        except ValueError as exc:
            self.send(400, {'error': str(exc)})
        except Exception as exc:
            self.send(502, {'error': str(exc)})


if __name__ == '__main__':
    print(f'Local demo listening on http://127.0.0.1:{PORT}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
