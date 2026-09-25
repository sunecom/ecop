"""Bounded, non-executing XLSX reader for ECOP taskbook v1."""
import sys, json, zipfile, io, posixpath, re
import xml.etree.ElementTree as ET
from pathlib import Path

NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def parse(data):
    if len(data)>300*1024: raise ValueError('任务书上限 300 KiB；请删除图片，附件只填写索引。')
    z=zipfile.ZipFile(io.BytesIO(data)); infos=z.infolist()
    if len(infos)>150 or sum(i.file_size for i in infos)>4*1024*1024: raise ValueError('工作簿解压体积或文件数超限。')
    names=[i.filename for i in infos]
    if len(names)!=len(set(names)): raise ValueError('工作簿存在重复文件项。')
    if any(i.flag_bits&1 or i.file_size>2*1024*1024 or '..' in i.filename.split('/') for i in infos): raise ValueError('工作簿结构无效或包含加密内容。')
    if any('vbaproject' in n.lower() or 'externallink' in n.lower() or 'embedding' in n.lower() for n in names): raise ValueError('请使用无宏、无外链和无嵌入对象的 xlsx。')
    def xml(n):
        b=z.read(n)
        if b'<!DOCTYPE' in b.upper() or b'<!ENTITY' in b.upper(): raise ValueError('不支持 XML 实体或 DTD。')
        return ET.fromstring(b)
    for n in names:
        if n.endswith('.rels'):
            if any(e.get('TargetMode')=='External' for e in xml(n)): raise ValueError('请删除工作簿中的外部链接后上传。')
    strings=[]
    if 'xl/sharedStrings.xml' in names:
        strings=[''.join(e.itertext()) for e in xml('xl/sharedStrings.xml')]
    rel={e.get('Id'):e.get('Target') for e in xml('xl/_rels/workbook.xml.rels')}
    sheets={}
    for s in xml('xl/workbook.xml').findall('s:sheets/s:sheet',NS):
        target=rel[s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
        target=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
        cells={}
        for c in xml(target).findall('.//s:sheetData/s:row/s:c',NS):
            ref=c.get('r','')
            if not re.fullmatch(r'[A-Z]{1,2}[1-9][0-9]{0,3}',ref): raise ValueError('单元格范围超限。')
            if c.find('s:f',NS) is not None: raise ValueError(f'{s.get("name")}!{ref} 含公式，请填写核对后的数值，不使用公式缓存。')
            if c.get('t')=='e': raise ValueError(f'{s.get("name")}!{ref} 含 Excel 错误值。')
            v=c.find('s:v',NS)
            if c.get('t')=='s': value=strings[int(v.text)] if v is not None else ''
            elif c.get('t')=='inlineStr': value=''.join(c.find('s:is',NS).itertext())
            else: value=v.text if v is not None else ''
            if len(value or '')>4096: raise ValueError(f'{ref} 文本超长。')
            if value: cells[ref]=value.strip()
        if len(cells)>5000: raise ValueError('单元格数量超限。')
        sheets[s.get('name')]=cells
    expected=['设计条件','物性与实验','公用工程与约束','附件与修订']
    if set(sheets)!=set(expected): raise ValueError('请使用标准四工作表模板，不增删或重命名工作表。')
    definitions=json.loads(Path(__file__).with_name('taskbook-fields.json').read_text(encoding='utf8'))
    defs={f[0]:f for f in definitions}; seen=set(); fields=[]; issues=[]; experiments=[]
    def issue(sheet,cell,id,msg,gate='需求'):
        issues.append(dict(sheet=sheet,cell=cell,field=id,message=msg,impact=gate,severity='error' if gate=='需求' else 'warning'))
    for name,cells in sheets.items():
        if cells.get('A1')!='ECOP-TASKBOOK-1': raise ValueError(f'{name}!A1 模板版本不支持。')
        experiment=False; header=False
        for row in sorted({int(re.search(r'\d+',k)[0]) for k in cells if int(re.search(r'\d+',k)[0])>=4}):
            vals=[cells.get(f'{col}{row}','') for col in 'ABCDEFGH']; id=vals[0]
            if id=='EXPERIMENTS': experiment=True;header=True;continue
            if experiment:
                if header:header=False;continue
                if any(vals):
                    experiments.append(dict(sheet=name,row=row,values=vals))
                    issue(name,f'A{row}',id,'实验记录已保留；请由工程师核对浓度依据、温度单位、压力及测量条件。','计算')
                continue
            if not id or id not in defs or defs[id][2]!=name or id in seen:
                issue(name,f'A{row}',id,'字段编号缺失、重复、未知或位于错误工作表；请重新下载模板。');continue
            seen.add(id); _,label,_,kind,units,gate,note=defs[id]
            raw=vals[2]; unit=vals[3]; basis=vals[4]; status=vals[5]; value=raw or None
            if status not in ['待补充','待核对','实测','设计要求','估计','不适用']: issue(name,f'F{row}',id,'请选择有效数据状态。')
            if value is None:
                if gate=='需求' or status!='不适用':issue(name,f'C{row}',id,f'{label}尚未提供。',gate)
            else:
                if status in ['待补充','不适用']:issue(name,f'F{row}',id,'数据已有值，但状态为待补充或不适用，请核对。')
                if status in ['待核对','估计']:issue(name,f'F{row}',id,'请核对数值和来源；估计值需明确假设，不能当作实测数据。',gate)
                if kind=='number':
                    if not re.fullmatch(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?',raw):issue(name,f'C{row}',id,'请填写有限数值，文字说明移入来源或备注。');value=None
                    else:
                        value=float(raw)
                        if not -1e12<value<1e12:issue(name,f'C{row}',id,'数值超出可接受范围。');value=None
                if units and unit not in units:issue(name,f'D{row}',id,'单位需为：'+' / '.join(units)+'；当前单位未转换。')
                if id.endswith('_concentration'):
                    match={'wt%':'mass_percent','kg/kg':'mass_fraction','g/L':'mass_per_volume','°Brix':'refractometer_brix'}
                    if basis!=match.get(unit):issue(name,f'E{row}',id,'浓度定义/基准与单位不符，请按填写说明选择。')
                    limit=1 if unit=='kg/kg' else 100 if unit in ['wt%','°Brix'] else 1e12
                    if isinstance(value,float) and not 0<value<=limit:issue(name,f'C{row}',id,'浓度数值范围无效。')
                if id=='requirements.concentration_component' and value not in ['total_solids','maltitol_only','other']:issue(name,f'C{row}',id,'请选择 total_solids / maltitol_only / other 并说明含义。')
                if isinstance(value,float):
                    if id in ['requirements.feed_rate','requirements.atmospheric_pressure','requirements.liquid_density','requirements.dynamic_viscosity'] and value<=0:issue(name,f'C{row}',id,'此数值必须大于零。')
                    if 'temperature' in id and value<(-273.15 if unit=='°C' else 0):issue(name,f'C{row}',id,'温度低于绝对零度。')
                    if id=='requirements.ph' and not 0<=value<=14:issue(name,f'C{row}',id,'pH 超出常规范围，请核对。')
            fields.append(dict(target_field=id,label=label,value=value,raw_value=raw,unit=unit,value_basis=basis,data_status=status,source_reference=dict(sheet=name,cell=f'C{row}',description=vals[6]),note=vals[7]))
    for id,f in defs.items():
        if id not in seen:issue(f[2],'A',id,'标准字段缺失，请恢复该字段行。')
    by={f['target_field']:f for f in fields}
    a=by.get('requirements.feed_concentration',{});b=by.get('requirements.product_concentration',{})
    if a.get('value') is not None and b.get('value') is not None:
        if a.get('unit')!=b.get('unit') or a.get('value_basis')!=b.get('value_basis'):issue('设计条件',b['source_reference']['cell'],b['target_field'],'进出料浓度口径不同，不能直接进行守恒校核。')
        elif isinstance(a['value'],float) and isinstance(b['value'],float) and b['value']<=a['value']:issue('设计条件',b['source_reference']['cell'],b['target_field'],'浓缩任务目标浓度应高于进料浓度，请核对任务目标。')
    return dict(format_version='ECOP-TASKBOOK-1',fields=fields,experiments=experiments,issues=issues,blocking_count=sum(x['severity']=='error' for x in issues))

if __name__=='__main__':
    try: print(json.dumps(dict(ok=True,report=parse(sys.stdin.buffer.read(300*1024+1))),ensure_ascii=False))
    except Exception as e: print(json.dumps(dict(ok=False,error=str(e)),ensure_ascii=False));sys.exit(1)
