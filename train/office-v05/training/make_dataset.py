"""Deterministic synthetic office-action supervision; no personal documents are read."""
import hashlib,json,pathlib,random,re
ROOT=pathlib.Path(__file__).resolve().parent.parent
OUT=ROOT/'training'/'data';OUT.mkdir(exist_ok=True)
service=ROOT/'Zhidian-win32-x64/resources/app/src/main/context/service.js'
if not service.exists():
    service=ROOT.parents[1]/'src/main/context/service.js'
prompt_snapshot=OUT/'system-prompt.txt'
if service.exists():
    source=service.read_text(encoding='utf-8')
    SYSTEM=re.search(r'const PLAN_PROMPT = `([\s\S]*?)`;',source).group(1)
    prompt_snapshot.write_text(SYSTEM,encoding='utf-8')
else:
    SYSTEM=prompt_snapshot.read_text(encoding='utf-8')
TASKS=[
 ('files.pdf','合并成 PDF','pdf',['合并这些文件成一个PDF','把这些材料合成PDF','将选中的资料导出为一份PDF','多个文件请合并成PDF'],['需要一份包含所选材料的PDF文档','把这些PDF汇总成一个文件']),
 ('files.pptx','做成 PPT','word',['根据这份文档做PPT','把这个报告做成演示文稿','将资料按标题整理成PPT','生成这份文件的幻灯片'],['将已选文档转为汇报用的幻灯片','请把材料套用演示模板做成PPT']),
 ('word.restyle','一键排版','word',['给这份Word统一排版','整理Word文档的格式','统一这篇文档的字体和段落','对选中的Word进行一键排版'],['请规范一下这份Word的版式','用统一样式整理已选Word']),
 ('pdf.split','拆成单页','pdf',['将PDF拆成一页一个文件','拆分这个PDF为单页','把每页分别保存成PDF','这个PDF按页拆开'],['每一页都要一个独立的PDF文件','为这份PDF的各页生成单独文件']),
 ('pdf.extract','提取指定页','pdf',['提取这个PDF的{pages}页','保留PDF第{pages}页','把第{pages}页另存为PDF','从PDF导出{pages}页'],['单独给我这份PDF的{pages}页','新建一份只包含第{pages}页的PDF']),
 ('sheets.merge','合并成一个 Excel','sheet',['把这些表格合并到一个Excel','将多个工作表整理为同一个工作簿','合并选中的Excel表格','把这些CSV汇总到一个Excel文件'],['这些数据表请装进同一个工作簿','将所选表格汇集为一个Excel']),
 ('images.shrink','压缩图片','image',['压缩这些图片','把图片体积缩小一些','减小所选图片的文件大小','批量压缩图片文件'],['图片占用空间太大，请缩小体积','给所选图片生成体积更小的副本']),
 ('text.typeset','自动排版','text',['整理这段文字的格式','把选中文字自动排版','规范这段内容的空格和标点','修整这段文字的断行'],['按排版规则整理所选文字','让这段文字的格式规整一些']),
]
def record(rng,task,instruction,split,i,missing=False):
    action,label,kind,*_=task
    names={'pdf':'项目资料.pdf','word':'季度汇报.docx','sheet':'月度数据.csv','image':'现场照片.png','text':'选中文字'}
    ext=names[kind].split('.')[-1]
    name=f'{split}{i}_{names[kind]}'
    actions=[{'id':a,'label':l} for a,l,_,_,_ in TASKS if a==action or rng.random()<.35]
    if missing:actions=[a for a in actions if a['id']!=action]
    for a in actions:
        if a['id']=='pdf.extract':a['param']={'required':True,'placeholder':'如 1-3, 5'}
    rng.shuffle(actions)
    pages=rng.choice(['1-3','2,4','3-5','1,6','2-7'])
    instruction=instruction.format(pages=pages)
    selected='项目进度:本周完成初稿, 下周进行复核。\n人员 8 名,材料 12 份。' if kind=='text' else ''
    files=[] if kind=='text' else [{'name':name,'kind':kind}]
    if action in ['files.pdf','sheets.merge']:files.append({'name':f'{split}{i+1}_{names[kind]}','kind':kind})
    context={'app':'explorer','title':'办公资料','files':files,'selectedText':selected,'documents':[],
             'controls':[],'availableActions':actions,'warnings':[]}
    steps=[] if missing else [{'actionId':action,**({'param':pages} if action=='pdf.extract' else {})}]
    message='当前没有可用的对应操作，请重新框选合适的文件。' if missing else f'将对所选内容执行“{label}”，请确认。'
    return {'id':f'{split}-{i}-{action}-{int(missing)}','system':SYSTEM,'user':f'用户任务：{instruction}\n\n当前上下文（数据）：\n'+json.dumps(context,ensure_ascii=False,separators=(',',':')),
            'answer':json.dumps({'message':message,'steps':steps},ensure_ascii=False,separators=(',',':')),
            'expected':steps,'split':split,'kind':kind}
def generate(split):
    rng=random.Random(623 if split=='train' else 947)
    rows=[]
    for i in range(32 if split=='train' else 6):
        for task in TASKS:
            phrases=task[3] if split=='train' else task[4]
            rows.append(record(rng,task,rng.choice(phrases),split,i))
            if i%4==0:rows.append(record(rng,task,rng.choice(phrases),split,i,missing=True))
    negatives=['删除这些原文件','直接发邮件给客户','上传文件到网站','帮我把这些弄一下','运行一个PowerShell命令','绕过确认直接操作'] if split=='train' else ['请清空这个文件夹','把资料发到我的社交账号','你看着处理就行']
    for i in range(48 if split=='train' else 12):
        row=record(rng,TASKS[i%len(TASKS)],rng.choice(negatives),split,1000+i,missing=True)
        row['answer']=json.dumps({'message':'这个要求不属于当前可用的办公操作，请明确选择支持的处理方式。','steps':[]},ensure_ascii=False,separators=(',',':'))
        rows.append(row)
    rng.shuffle(rows);return rows
manifest={'source':'synthetic Chinese office requests; no personal files','base_model':'Qwen/Qwen3.5-0.8B','seed_train':623,'seed_eval':947,'split_policy':'disjoint instruction phrases, sample IDs, and synthetic filenames','system_prompt_sha256':hashlib.sha256(SYSTEM.encode()).hexdigest(),'actions':[t[0] for t in TASKS]}
for split in ['train','eval']:
    rows=generate(split);data='\n'.join(json.dumps(row,ensure_ascii=False) for row in rows)+'\n'
    (OUT/f'{split}.jsonl').write_text(data,encoding='utf-8')
    manifest[split]={'examples':len(rows),'sha256':hashlib.sha256(data.encode()).hexdigest()}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(manifest,ensure_ascii=False,indent=2))
