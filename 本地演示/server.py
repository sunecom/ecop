from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.request import Request, urlopen
import json, math, threading, time, uuid, secrets, os

BASE=Path(__file__).resolve().parent
PORT=18765
MCP=os.environ.get('DWSIM_MCP_URL','http://localhost:15901/mcp')
TOKEN=Path(os.environ.get('DWSIM_TOKEN_FILE',str(BASE.parent/'.local/mcp-token.txt'))).read_text().strip()
RUNS=Path(os.environ.get('ECOP_RUNS_DIR',str(BASE/'runs')))
NONCE=secrets.token_urlsafe(24)
LOCK=threading.Lock()
SHA=os.environ.get('DWSIM_BUILD_REFERENCE','0cd6a30ce1b5eb976cdd94495d102a9691b067f5')

def rpc(method,params=None):
    data=json.dumps({'jsonrpc':'2.0','id':uuid.uuid4().hex,'method':method,'params':params or {}}).encode()
    req=Request(MCP,data,{'Content-Type':'application/json','X-MCP-Token':TOKEN})
    with urlopen(req,timeout=90) as r: body=json.load(r)
    if 'error' in body: raise RuntimeError(str(body['error']))
    return body['result']

def call(tool_name,**args):
    r=rpc('tools/call',{'name':tool_name,'arguments':args})
    if r.get('isError'):raise RuntimeError(str(r.get('content')))
    return json.loads(next(c['text'] for c in r['content'] if c['type']=='text'))

def validate(data):
    if not isinstance(data,dict):raise ValueError('请求必须为 JSON 对象')
    out={}
    for name,lo,hi in [('flow_kg_h',10,100000),('temperature_C',5,80),('pressure_kPa',60,300),('vapor_percent',1,95)]:
        v=data.get(name)
        if isinstance(v,bool) or not isinstance(v,(float,int)) or not math.isfinite(v) or not lo<=v<=hi:
            raise ValueError(f'{name} 必须在 {lo} 至 {hi} 之间')
        out[name]=float(v)
    return out

def calculate(data):
    values=validate(data)
    if not LOCK.acquire(blocking=False):raise ValueError('已有计算正在进行，请稍后再试')
    fid=None
    try:
        start=time.monotonic()
        fid=call('dwsim_flowsheet_create',name='ECOP water evaporation demo')['flowsheet_id']
        def tool(tool_name,**kwargs):return call(tool_name,flowsheet_id=fid,**kwargs)
        tool('dwsim_thermo_add_compounds',names=['Water'])
        packs=tool('dwsim_thermo_list_property_packages')['property_packages']
        pp=next(n for n in packs if 'Steam' in n)
        tool('dwsim_thermo_set_property_package',name=pp)
        tool('dwsim_stream_add_material',name='FEED',temperature_K=values['temperature_C']+273.15,pressure_Pa=values['pressure_kPa']*1000,mass_flow_kg_s=values['flow_kg_h']/3600,composition={'Water':1.0})
        # This pinned upstream implementation treats composition values as compound
        # mass flows despite its fraction schema. Set total flow AFTER composition.
        tool('dwsim_stream_set_conditions',name='FEED',mass_flow_kg_s=values['flow_kg_h']/3600)
        actual=tool('dwsim_stream_get_results',name='FEED')['mass_flow_kg_s']
        if not math.isclose(actual,values['flow_kg_h']/3600,rel_tol=1e-8):raise RuntimeError('引擎进料流量与输入不一致')
        tool('dwsim_stream_add_material',name='PRODUCT')
        tool('dwsim_unitop_add',type='Heater',name='EV-01')
        tool('dwsim_unitop_connect',unitop='EV-01',feed_stream='FEED',product_stream='PRODUCT')
        applied=tool('dwsim_unitop_set',name='EV-01',properties={'CalcMode':'OutletVaporFraction','OutletVaporFraction':values['vapor_percent']/100,'DeltaP':0,'Eficiencia':100})
        check=tool('dwsim_flowsheet_check')
        solved=tool('dwsim_solve_run',timeout_s=60)
        if not solved.get('ok'):raise RuntimeError(json.dumps(solved,ensure_ascii=False))
        if any(not o['calculated'] for o in solved['objects'] if o['name'] in ['FEED','PRODUCT','EV-01']):raise RuntimeError('计算对象尚未全部完成')
        feed=tool('dwsim_stream_get_results',name='FEED')
        product=tool('dwsim_stream_get_results',name='PRODUCT')
        unit=tool('dwsim_unitop_get_results',name='EV-01')
        def mix(s):return next(p for p in s['phases'] if p['name'].lower() in ['mixture','overall'])
        vf=next(p['fraction'] for p in product['phases'] if p['name'].lower()=='vapor')
        duty=product['mass_flow_kg_s']*mix(product)['enthalpy_kJ_kg']-feed['mass_flow_kg_s']*mix(feed)['enthalpy_kJ_kg']
        result={'run_id':uuid.uuid4().hex,'time':time.strftime('%Y-%m-%d %H:%M:%S'),'inputs':values,'engine':'DWSIM 10.2.8','commit':SHA,'property_package':pp,'elapsed_s':round(time.monotonic()-start,2),'results':{'outlet_temperature_C':product['temperature_K']-273.15,'heat_duty_kW':duty,'vapor_kg_h':product['mass_flow_kg_s']*vf*3600,'liquid_kg_h':product['mass_flow_kg_s']*(1-vf)*3600,'vapor_fraction':vf,'mass_residual_kg_h':(feed['mass_flow_kg_s']-product['mass_flow_kg_s'])*3600},'raw':{'feed':feed,'product':product,'unit':unit,'check':check,'solve':solved,'applied':applied}}
        path=RUNS;path.mkdir(parents=True,exist_ok=True)
        (path/(result['run_id']+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        return result
    finally:
        if fid:
            try:call('dwsim_flowsheet_close',flowsheet_id=fid)
            except Exception:pass
        LOCK.release()

class Handler(BaseHTTPRequestHandler):
    def send(self,status,data,ctype='application/json; charset=utf-8'):
        if not isinstance(data,bytes):data=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if self.path=='/':self.send(200,(BASE/'index.html').read_text(encoding='utf-8').replace('__NONCE__',NONCE).encode(),'text/html; charset=utf-8')
        elif self.path=='/logo.png':self.send(200,(BASE/'logo.png').read_bytes(),'image/png')
        elif self.path=='/api/status':
            try:
                r=rpc('tools/list');self.send(200,{'ok':True,'tools':len(r['tools']),'engine':'DWSIM 10.2.8','commit':SHA})
            except Exception as e:self.send(503,{'ok':False,'error':str(e)})
        else:self.send(404,{'error':'Not found'})
    def do_POST(self):
        if self.path!='/api/calculate':return self.send(404,{'error':'Not found'})
        if self.headers.get('X-Demo-Token')!=NONCE:return self.send(403,{'error':'请刷新本地页面后重试'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<4096:raise ValueError('请求大小不正确')
            self.send(200,calculate(json.loads(self.rfile.read(length))))
        except ValueError as e:self.send(400,{'error':str(e)})
        except Exception as e:self.send(502,{'error':str(e)})

if __name__=='__main__':
    print(f'Local demo listening on http://127.0.0.1:{PORT}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
