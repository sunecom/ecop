"""Curated Chinese presentation metadata for the verified DWSIM engine inventory."""

TOOL_GROUPS = [
    {'id': 'flowsheet', 'name': '流程生命周期', 'summary': '创建、载入、保存、关闭、盘点与摘要。'},
    {'id': 'thermo', 'name': '组分与物性', 'summary': '查询组分库、选择组分并配置物性包。'},
    {'id': 'stream', 'name': '物流与能流', 'summary': '建立物流/能流，设置条件并读取相态结果。'},
    {'id': 'unitop', 'name': '单元操作', 'summary': '添加、连接、配置并读取设备计算结果。'},
    {'id': 'solve', 'name': '求解与诊断', 'summary': '预检查、稳态求解和失败原因诊断。'},
    {'id': 'graphic', 'name': '流程图与标注', 'summary': '管理图形对象并渲染 PFD 图像。'},
    {'id': 'dynamics', 'name': '动态仿真与控制', 'summary': '动态建模、事件、监控、PID、运行与分析。'},
]


def tool_group(tool_name):
    if tool_name == 'dwsim_flowsheet_check':
        return 'solve'
    if tool_name.startswith('dwsim_flowsheet_') or tool_name == 'dwsim_object_rename':
        return 'flowsheet'
    for prefix, group in [
        ('dwsim_thermo_', 'thermo'),
        ('dwsim_stream_', 'stream'),
        ('dwsim_unitop_', 'unitop'),
        ('dwsim_solve_', 'solve'),
        ('dwsim_graphic_', 'graphic'),
        ('dwsim_dynamics_', 'dynamics'),
    ]:
        if tool_name.startswith(prefix):
            return group
    return 'flowsheet'


UNIT_GROUPS = [
    {
        'id': 'transport',
        'name': '传热、流体与储运',
        'code': 'A',
        'summary': '完成物流合并、分流、升降压、换热、管输与容积设备计算。',
        'inputs': ['物流组成与状态', '目标压力/温度或设备规格', '效率、压降与几何参数'],
        'outputs': ['出口物流状态', '热负荷或轴功率', '压降、相态与设备结果'],
        'scenarios': ['预热与冷却', '泵压缩与节流', '管线输送', '缓冲与闪蒸'],
        'types': ['Mixer', 'Splitter', 'Heater', 'Cooler', 'Pump', 'Compressor', 'Expander',
                  'Valve', 'Pipe', 'HeatExchanger', 'Tank', 'Vessel', 'OrificePlate'],
    },
    {
        'id': 'separation',
        'name': '分离、膜与塔器',
        'code': 'B',
        'summary': '覆盖组分拆分、固液分离、精馏吸收以及生物分离单元。',
        'inputs': ['进料物流', '分离规格或级数', '压力、回流与目标纯度'],
        'outputs': ['产品流量与组成', '级间状态或分离效率', '能耗与收率'],
        'scenarios': ['精馏与吸收', '固液/组分分离', '膜过滤', '结晶与纯化'],
        'types': ['ComponentSeparator', 'Filter', 'SolidsSeparator', 'ShortcutColumn',
                  'DistillationColumn', 'AbsorptionColumn', 'Centrifuge', 'Chromatography',
                  'CrossflowUF', 'Crystallizer'],
    },
    {
        'id': 'reaction',
        'name': '反应、生化与资源化',
        'code': 'C',
        'summary': '从常规反应器到生物过程、热解和原料预处理的模型入口。',
        'inputs': ['反应体系与组分', '转化率/平衡/动力学参数', '温压、停留时间与操作条件'],
        'outputs': ['产物组成与转化率', '反应热与温度', '生化/资源化过程指标'],
        'scenarios': ['化学反应', '生物反应与厌氧消化', '热解', '原料预处理与升级'],
        'types': ['ConversionReactor', 'EquilibriumReactor', 'GibbsReactor', 'CSTR', 'PFR',
                  'ReaktoroGibbsReactor', 'BioReactor', 'AnaerobicDigester',
                  'CFBFastPyrolysis', 'Pretreatment', 'BiogasUpgrader', 'CellLysis'],
    },
    {
        'id': 'energy',
        'name': '清洁能源',
        'code': 'D',
        'summary': '面向风、水、光、氢与燃料电池的能量转换模型。',
        'inputs': ['资源条件或进料', '设备额定参数', '效率与电化学参数'],
        'outputs': ['功率与效率', '产品流量', '设备状态与能量衡算'],
        'scenarios': ['可再生能源评估', '制氢', '燃料电池发电'],
        'types': ['WindTurbine', 'HydroelectricTurbine', 'SolarPanel', 'WaterElectrolyzer',
                  'PEMFuelCell'],
    },
    {
        'id': 'logic',
        'name': '流程逻辑与收敛',
        'code': 'E',
        'summary': '处理循环撕裂、能量回路、规格约束和变量调节。',
        'inputs': ['被控变量与目标值', '操纵变量', '收敛容差与迭代设置'],
        'outputs': ['收敛状态', '调整后的变量', '循环与规格诊断'],
        'scenarios': ['循环流程收敛', '设计规格', '能量回收约束'],
        'types': ['Recycle', 'EnergyRecycle', 'Spec', 'Adjust'],
    },
]


UNIT_NAMES = {
    'Mixer': '混合器', 'Splitter': '分流器', 'Heater': '加热器', 'Cooler': '冷却器',
    'Pump': '泵', 'Compressor': '压缩机', 'Expander': '膨胀机', 'Valve': '阀门',
    'Pipe': '管段', 'HeatExchanger': '换热器', 'Tank': '储罐', 'Vessel': '容器 / 闪蒸罐',
    'OrificePlate': '孔板', 'ComponentSeparator': '组分分离器', 'Filter': '过滤器',
    'SolidsSeparator': '固体分离器', 'ShortcutColumn': '简捷精馏塔',
    'DistillationColumn': '严格精馏塔', 'AbsorptionColumn': '吸收塔', 'Centrifuge': '离心机',
    'Chromatography': '色谱分离', 'CrossflowUF': '错流超滤 / 洗滤', 'Crystallizer': '结晶器',
    'ConversionReactor': '转化率反应器', 'EquilibriumReactor': '平衡反应器',
    'GibbsReactor': 'Gibbs 反应器', 'CSTR': '全混流反应器', 'PFR': '平推流反应器',
    'ReaktoroGibbsReactor': 'Reaktoro Gibbs 反应器', 'BioReactor': '生物反应器',
    'AnaerobicDigester': '厌氧消化器', 'CFBFastPyrolysis': '循环流化床快速热解',
    'Pretreatment': '原料预处理', 'BiogasUpgrader': '沼气提纯', 'CellLysis': '细胞裂解',
    'WindTurbine': '风力机', 'HydroelectricTurbine': '水轮机', 'SolarPanel': '光伏组件',
    'WaterElectrolyzer': '水电解槽', 'PEMFuelCell': 'PEM 燃料电池', 'Recycle': '物料循环',
    'EnergyRecycle': '能量循环', 'Spec': '设计规格', 'Adjust': '变量调节',
}


UNIT_SUMMARIES = {
    'Mixer': '合并多股物流并完成质量与能量衡算。',
    'Splitter': '按指定比例或流量将一股物流拆分。',
    'Heater': '以热负荷、出口温度或汽相分数等规格改变物流状态。',
    'Cooler': '移除热量并求解冷却后的物流状态。',
    'Pump': '液相升压并计算轴功率与出口状态。',
    'Compressor': '气相压缩，计算功率、效率和出口温度。',
    'Expander': '气体膨胀做功并求解出口状态。',
    'Valve': '通过节流压降改变物流压力与相态。',
    'Pipe': '计算沿程压降、传热与多相管流。',
    'HeatExchanger': '耦合冷热物流，完成换热与相变计算。',
    'Tank': '描述带存量的储罐过程对象。',
    'Vessel': '进行容积、闪蒸和气液分离相关计算。',
    'OrificePlate': '依据孔板和流体条件估算流量或压差。',
    'ComponentSeparator': '按组分回收率或分配规格拆分混合物。',
    'Filter': '描述过滤介质上的固液分离。',
    'SolidsSeparator': '从物流中分离固体相或颗粒。',
    'ShortcutColumn': '用简捷方法快速估算精馏分离与能耗。',
    'DistillationColumn': '执行多级严格气液平衡与塔器规格求解。',
    'AbsorptionColumn': '执行多级吸收/解吸过程计算。',
    'Centrifuge': '利用离心作用进行生物或固液分离。',
    'Chromatography': '描述色谱介质中的组分分离。',
    'CrossflowUF': '描述错流超滤/洗滤、膜通量和截留。',
    'Crystallizer': '描述过饱和、晶体生成与母液分离。',
    'ConversionReactor': '按照指定反应转化率计算产物。',
    'EquilibriumReactor': '依据化学平衡常数求解反应平衡。',
    'GibbsReactor': '通过 Gibbs 自由能最小化求平衡组成。',
    'CSTR': '稳态连续搅拌釜反应器模型。',
    'PFR': '沿程积分的平推流反应器模型。',
    'ReaktoroGibbsReactor': '通过 Reaktoro 扩展求解复杂平衡体系。',
    'BioReactor': '描述生物转化、底物消耗与产物生成。',
    'AnaerobicDigester': '描述厌氧消化与沼气生成过程。',
    'CFBFastPyrolysis': '描述循环流化床快速热解过程。',
    'Pretreatment': '描述生物质或原料预处理步骤。',
    'BiogasUpgrader': '对沼气进行提纯与产品气质量计算。',
    'CellLysis': '描述细胞破碎与胞内物质释放。',
    'WindTurbine': '依据风况和设备参数估算发电功率。',
    'HydroelectricTurbine': '依据水头与流量估算水力发电。',
    'SolarPanel': '依据辐照与组件参数估算光伏输出。',
    'WaterElectrolyzer': '由电功和水进料计算氢氧产品。',
    'PEMFuelCell': '描述质子交换膜燃料电池的发电过程。',
    'Recycle': '为物料循环提供撕裂流与收敛迭代。',
    'EnergyRecycle': '处理能量回路的迭代与收敛。',
    'Spec': '定义流程变量必须满足的设计规格。',
    'Adjust': '改变操纵变量，使被控变量达到目标。',
}


PLATFORM_MODULES = [
    {'id': 'flowsheet', 'name': '流程生命周期', 'state': 'engine',
     'summary': '创建、载入、保存、关闭、对象盘点、摘要与 XML 检查。',
     'input': '流程名称或受控文件', 'output': '流程句柄、对象清单与摘要'},
    {'id': 'thermo', 'name': '热力学配置', 'state': 'engine',
     'summary': '组分库、物性包选择以及物流相态计算的基础。',
     'input': '组分与物性方法', 'output': '相平衡和热物性'},
    {'id': 'streams', 'name': '物流与能流', 'state': 'engine',
     'summary': '创建物流/能流、设定状态与读取多相结果。',
     'input': '温度、压力、流量、组成', 'output': '相态、焓、密度与流量'},
    {'id': 'solve', 'name': '稳态求解与诊断', 'state': 'engine',
     'summary': '求解前检查、顺序模块求解与故障定位。',
     'input': '已连接的流程图', 'output': '收敛结果与可执行修复建议'},
    {'id': 'graphics', 'name': 'PFD 图形与标注', 'state': 'engine',
     'summary': '图形对象、数据表、标注与流程图 PNG 渲染。',
     'input': '对象位置、标签与显示属性', 'output': '图形清单或 PFD 图像'},
    {'id': 'dynamics', 'name': '动态仿真与控制', 'state': 'engine',
     'summary': '动态检查、积分、事件、变量监控、PID、分析与诊断。',
     'input': '动态对象、计划、事件与控制器', 'output': '时间序列与控制品质指标'},
]


DESKTOP_MODULES = [
    {'name': '桌面流程图编辑器', 'state': 'desktop', 'summary': '完整拖拽建模、属性编辑和多窗口交互属于桌面端体验。'},
    {'name': '灵敏度与优化', 'state': 'desktop', 'summary': '官方桌面环境提供优化与灵敏度工作流；当前 MCP 目录未提供通用网页接口。'},
    {'name': '数据回归', 'state': 'desktop', 'summary': '实验数据拟合与二元交互参数回归需使用桌面工具和数据集。'},
    {'name': '反应管理器', 'state': 'desktop', 'summary': '反应、反应集和动力学编辑需要专用建模界面，当前网页未接入。'},
    {'name': 'CAPE-OPEN / 外部单元', 'state': 'extension', 'summary': '引擎存在扩展入口，但实际可用性取决于服务器安装的第三方组件。'},
    {'name': '脚本、电子表格与插件', 'state': 'desktop', 'summary': '桌面自动化与插件生态不在当前受控 Web 服务的暴露范围内。'},
]


STATUS_LEGEND = [
    {'id': 'live', 'name': '已接入可运行', 'summary': '网页已有受控输入、真实求解、校核和结果记录。'},
    {'id': 'engine', 'name': '引擎可用 · 网页待接入', 'summary': '云端引擎可调用，但尚未制作专用参数与校核流程。'},
    {'id': 'desktop', 'name': '桌面 / 扩展能力', 'summary': '需要桌面交互、外部组件或额外工程开发。'},
]


def build_unit_groups(available_types):
    available = set(available_types)
    live_modules = {
        'Heater': {
            'summary': '已接入目标汽化与按出口温度加热两种纯水真实求解。',
            'inputs': ['纯水流量', '入口温度', '绝对压力', '目标汽化比例或出口温度'],
            'outputs': ['热负荷', '出口温度与压力', '相态和物料衡算残差'],
            'scenarios': ['纯水目标汽化', '纯水显热升温'],
            'route': '#workbench',
            'workspace_mode': 'evaporation',
        },
        'Cooler': {
            'summary': '已接入纯水按目标出口温度冷却的真实求解。',
            'inputs': ['纯水流量', '入口温度', '绝对压力', '目标出口温度'],
            'outputs': ['净吸热（负值表示移热）', '出口状态', '相态和物料衡算残差'],
            'scenarios': ['纯水显热冷却'],
            'route': '#workbench',
            'workspace_mode': 'temperature',
        },
        'Pump': {
            'summary': '已接入单液相纯水升压，计算轴功率和出口状态。',
            'inputs': ['纯水流量与入口状态', '目标出口绝对压力', '泵效率'],
            'outputs': ['轴功率与水力功率', '出口温度与压力', '压升和效率校核'],
            'scenarios': ['纯水输送泵工况估算'],
            'route': '#workbench',
            'workspace_mode': 'pump',
        },
        'Mixer': {
            'summary': '已接入两股纯水等压混合，校核质量与焓流守恒。',
            'inputs': ['两股纯水流量与温度', '两股进料绝对压力'],
            'outputs': ['出口流量、温度与压力', '质量与焓流残差'],
            'scenarios': ['两股纯水工况混合'],
            'route': '#workbench',
            'workspace_mode': 'mixer',
        },
        'Splitter': {
            'summary': '已接入纯水两路按质量比例分流。',
            'inputs': ['纯水流量与入口状态', '1号出口分流比'],
            'outputs': ['两路出口流量与状态', '实际分流比与质量残差'],
            'scenarios': ['工艺物流定比分配'],
            'route': '#workbench',
            'workspace_mode': 'splitter',
        },
        'Valve': {
            'summary': '已接入纯水指定出口绝对压力的阀门节流。',
            'inputs': ['纯水流量与入口状态', '目标出口绝对压力'],
            'outputs': ['出口温压与汽相分数', '压降、质量与等焓校核'],
            'scenarios': ['纯水减压与节流后状态'],
            'route': '#workbench',
            'workspace_mode': 'valve',
        },
        'HeatExchanger': {
            'summary': '已接入两股单液相纯水换热，指定热侧出口并校核两侧热平衡。',
            'inputs': ['冷热侧纯水流量、温度与压力', '热侧目标出口温度'],
            'outputs': ['冷热侧出口状态', '换热负荷、两侧质量与热平衡残差'],
            'scenarios': ['纯水冷热物流热量回收'],
            'route': '#workbench',
            'workspace_mode': 'heat_exchanger',
        },
        'Compressor': {
            'summary': '已接入纯水蒸汽压缩，液相入口拒绝并校核压缩功与焓升。',
            'inputs': ['纯水蒸汽流量与入口状态', '目标出口压力', '绝热效率'],
            'outputs': ['压缩功率', '出口温压、压力比与功率残差'],
            'scenarios': ['纯水蒸汽升压'],
            'route': '#workbench',
            'workspace_mode': 'compressor',
        },
        'Vessel': {
            'summary': '已接入受控两相纯水进料的真实 Vessel 气液分离。',
            'inputs': ['纯水流量、预热前温度与分离压力', '两相进料汽相比例'],
            'outputs': ['汽液产品流量与相态', '质量、分配与焓流闭合'],
            'scenarios': ['纯水闪蒸后气液分离'],
            'route': '#workbench',
            'workspace_mode': 'vessel',
        },
    }
    groups = []
    for group in UNIT_GROUPS:
        modules = []
        for type_name in group['types']:
            if type_name not in available:
                continue
            live = type_name in live_modules
            module = {
                'type': type_name,
                'name': UNIT_NAMES[type_name],
                'summary': UNIT_SUMMARIES[type_name],
                'state': 'live' if live else 'engine',
                'inputs': group['inputs'],
                'outputs': group['outputs'],
                'scenarios': group['scenarios'],
            }
            if live:
                module.update(live_modules[type_name])
            modules.append(module)
        groups.append({**{key: value for key, value in group.items() if key != 'types'},
                       'count': len(modules), 'modules': modules})
    return groups
