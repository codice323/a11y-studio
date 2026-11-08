// Original evaluation fixtures. Selectors and expectations below are evaluator data,
// separate from the files sent to the application. d* are development; h* are holdout.
const oracle = (kind, target, control, expected, extra = {}) => ({ kind, target, control, expected, ...extra });
const label = (target, control, expected, extra) => oracle('label', target, control, expected, extra);
const link = (target, control, expected, extra) => oracle('link', target, control, expected, extra);
const contrast = (target, control) => oracle('contrast', target, control);
const focus = (target, control) => oracle('focus', target, control);
const alt = (target, control, expected) => oracle('alt', target, control, expected);
const aria = (target, control, expected, ref) => oracle('aria', target, control, expected, {ref});
const button = (target, control, expected, extra) => oracle('button', target, control, expected, extra);
function site(id, category, title, body, css, pairs, options = {}) {
  const { lang = 'zh-CN', entry = 'index.html', transport = 'zip', images = [], extraFiles = {} } = options;
  const style = 'body{background:#fff;color:#202530;font:16px Arial;margin:28px}img{max-width:160px}'+css;
  const embedded = transport === 'html';
  return {id, category, entry, transport, images, extraFiles, pairs, style,
    css: embedded ? null : 'site.css',
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>${embedded ? '<style>'+style+'</style>' : '<link rel="stylesheet" href="/site.css">'}</head><body>${body}</body></html>`};
}

export const generalizationSites = [
  site('d1-harbor','企业','港口设备服务',`<header><h1>澄海设备</h1><nav><a id="jump" href="#service"></a><a id="contact" href="#service">查看检修</a></nav></header><main><section id="service"><h2>预约设备检修</h2><dl><dt>服务时段</dt><dd class="quiet">周六 8:00–16:00</dd><dt>地址</dt><dd id="office">海岸路 60 号</dd></dl><form><fieldset><legend>维修回执</legend><input type="email" data-mail><label>工单 <input id="ticket"></label></fieldset></form><button id="hours">查询轮班</button><button id="directions">导航</button><p id="secondary">非营业时间请留言</p></section></main>`,
    'dd.quiet,#secondary{color:#aaa} #hours:focus{outline:none;box-shadow:none}', [
      label('[data-mail]','#ticket','邮箱|email'), link('#jump','#contact','预约设备检修'), contrast('dd.quiet','#office'), contrast('#secondary','#office'),focus('#hours','#directions'),
    ],{transport:'html'}),
  site('d2-printshop','电商','Letterpress Market',`<main><h1>Letterpress Market</h1><ol><li><article><h2>Workshop lights</h2><img data-product src="light.webp"><img id="photo-copy" src="light.webp" alt="Blue desk lamp"><p class="muted">Three in stock</p><p id="dispatch">Dispatch tomorrow</p><button id="pick" type="button" data-action="reserve workshop light"><span aria-hidden="true">＋</span></button><button id="info">Delivery information</button></article></li><li><article><h2>Print collection</h2><form><span>Postal code</span><input id="postal"><label>Order reference <input id="order"></label></form><button id="swatch">Show paper swatch</button></article></li></ol></main>`,
    '.muted{color:#aaa}#swatch:focus{outline:0}',[
      alt('[data-product]','#photo-copy','lamp|灯'),button('#pick','#info','reserve|reservation|预订|预留'),label('#postal','#order','Postal code|邮编',{human:'Postal code'}),contrast('.muted','#dispatch'),focus('#swatch','#info'),
    ],{lang:'en',images:[['light.webp','lamp']]}),
  site('d3-wire','新闻','山城早报',`<main><article><h1>旧桥通车实录</h1><header><time id="published">07:20</time><p id="verified">编辑部核实</p></header><figure><img id="scene" src="field.jpg"><img id="decoration" src="field.jpg" alt=""></figure><section><h2 id="topic">通车时刻表</h2><p>首班车八时发车。</p></section><footer><a id="schedule" href="#topic"></a><a id="source" href="#topic">正文依据</a><button id="save" aria-labelledby="old-word"></button><span id="word">收藏新闻</span><button id="print">打印</button></footer><aside id="note" style="color:#aaa!important">图文有更新</aside></article></main>`,
    'time{color:#aaa}article{max-width:42rem}',[
      alt('#scene','#decoration','桥|bridge'),contrast('#published','#verified'),contrast('#note','#verified'),link('#schedule','#source','通车时刻表'),aria('#save','#print','收藏新闻','word'),
    ],{images:[['field.jpg','bridge']]}),
  site('d4-lab','教育','Atelier de sciences',`<main><h1>Atelier de sciences</h1><aside><button class="toc">Index des expériences</button><button id="help">Aide</button></aside><section><h2>Inscription</h2><form><label>Code élève <input id="student"></label><div><span>Adresse e-mail :</span><input type="email"></div><div><span>Session :</span><select id="slot"><option>Mai</option></select></div></form></section><section><h2 id="calendar">Calendrier des ateliers</h2><p class="pale"><span id="due">Inscriptions ouvertes</span></p><p id="location">Bâtiment B</p><a id="cal" href="#calendar"></a><a id="guide" href="#calendar">Guide</a></section></main>`,
    '.toc:focus-visible{outline:none;box-shadow:none}.pale{color:#aaa}',[
      focus('.toc','#help'),label('input[type=email]','#student','email|e-mail|邮箱'),label('#slot','#student','Session',{human:'Session'}),contrast('#due','#location'),link('#cal','#guide','Calendrier des ateliers'),
    ],{lang:'fr',transport:'html'}),
  site('d5-clinic','表单','健康登记',`<main><h1>健康登记</h1><form action="/check-in"><fieldset><legend>回复渠道</legend><div><input id="line" autocomplete="tel"></div><label>日期 <input id="date" type="date"></label><div><input id="email" name="field-1" type="text"></div><p id="comment-text">补充说明：</p><textarea id="comment" placeholder="补充说明"></textarea></fieldset><section><p id="finish">提交健康登记</p><button type="submit" id="go" aria-labelledby="gone"></button><button id="clear" type="reset">清空</button></section></form><a id="opaque" href="/x/27"></a><a id="policy" href="#finish">须知</a></main>`,
    '',[
      label('#line','#date','电话|phone'),label('#email','#date','登记编号',{human:'登记编号',expectAbstain:true}),oracle('label','#comment','#date','补充说明',{negativeOnly:true}),aria('#go','#clear','提交健康登记','finish'),link('#opaque','#policy','',{expectAbstain:true,expectRefusal:true}),
    ],{transport:'html'}),
  site('d6-archives','多文件网站','地图档案',`<main><h1>地图档案</h1><section><h2>展品借阅</h2><p id="status" class="meta">周末暂停借出</p><p id="hint">到馆请携带证件</p><p class="meta" id="display">展品仅馆内查阅</p><form><div><span>邮箱：</span><input type="email" name="delivery"></div><label>姓名 <input id="reader"></label></form></section><button id="expand">查看馆藏</button><button id="request">申请复制</button><nav><a id="rules" href="#borrowing"></a><a id="news" href="#borrowing">最新规则</a></nav><h2 id="borrowing">借阅规则</h2></main>`,
    '.meta{color:#aaa} #expand:focus{outline:0}',[
      contrast('#status','#hint'),contrast('#display','#hint'),label('[name=delivery]','#reader','邮箱|email'),focus('#expand','#request'),link('#rules','#news','借阅规则'),
    ],{entry:'archives/index.html',extraFiles:{'annex.html':'<!doctype html><html lang="zh-CN"><title>附馆</title><link rel="stylesheet" href="/site.css"><main><h1>附馆</h1><p class="meta" id="status">独立页面的开放状态</p><button id="expand">展开分馆列表</button></main></html>'}}),

  site('h1-cooperative','企业','Mountain Grid Cooperative',`<header><h1>Mountain Grid Cooperative</h1></header><main><aside><p id="label" class="dim">Outage desk</p><p id="guide">Emergency guide</p></aside><section><h2 id="rota">Winter crew rota</h2><form><label>Member number <input id="number"></label><input type="tel" name="callback"></form><a id="rota-icon" href="#rota"></a><a id="staff" href="#rota">Staff schedule</a><button id="map">Open map</button><button id="hours">Office hours</button><p id="weather" style="color:#aaa!important">Snow closure</p></section></main>`,
    '.dim{color:#aaa} #map:focus{outline:none}',[
      contrast('.dim','#guide'),contrast('#weather','#guide'),label('[name=callback]','#number','电话|phone|telephone'),link('#rota-icon','#staff','Winter crew rota'),focus('#map','#hours'),
    ],{lang:'en',transport:'html'}),
  site('h2-garden','电商','种子交换店',`<main><h1>种子交换店</h1><article><h2>种植工具</h2><picture><img id="lamp" src="bulb.png"></picture><img id="stamp" src="bulb.png" alt=""><form><label>城市 <input id="city"></label><input name="ship" type="email"><button id="buy" aria-label="预订种植灯"><span aria-hidden="true">＋</span></button></form><p class="faint"><span id="availability">还剩两份</span></p><p id="pickup">可到店领取</p><button id="varieties">选择品种</button><button id="details">查看种植方法</button></article></main>`,
    '.faint{color:#aaa} #varieties:focus-visible{outline:none}',[
      alt('#lamp','#stamp','灯|lamp'),label('[name=ship]','#city','邮箱|email'),oracle('button','#buy','#details','预订种植灯',{negativeOnly:true}),contrast('#availability','#pickup'),focus('#varieties','#details'),
    ],{images:[['bulb.png','lamp']]}),
  site('h3-localpress','新闻','川谷通讯',`<main><article><h1>山区交通记录</h1><figure><img id="train" src="v.png"><figcaption>山区车站的轨道车辆</figcaption></figure><img id="divider" src="v.png" alt=""><p id="credit">摄影记者</p><p id="updated" class="note">修订于十时</p><section><h2 id="timeline">运营时间线</h2><a href="#timeline" data-jump></a><a id="full" href="#timeline">时间线详情</a><p id="story-action">加入阅读清单</p><button id="save" aria-labelledby="missing"></button><button id="share">转发</button></section><small id="license" class="note">仅供研究</small></article></main>`,
    '.note{color:#aaa}',[
      alt('#train','#divider','火车|列车|地铁|车厢|train'),contrast('#updated','#credit'),contrast('#license','#credit'),link('[data-jump]','#full','运营时间线'),aria('#save','#share','加入阅读清单','story-action'),
    ],{images:[['v.png','train']]}),
  site('h4-museum','教育','Children’s Museum Workshops',`<main><h1>Children’s Museum Workshops</h1><section><h2 id="schedule">Workshop schedule</h2><ul><li><a id="calendar" href="#schedule"></a><a id="registration" href="#schedule">Schedule details</a></li></ul><form><div><label>Age group <select id="age"><option>8–12</option></select></label></div><input type="search" data-search><div><span>Organization:</span><input name="org"></div></form><button id="next">Next session</button><button id="prev">Previous session</button><p id="times">All sessions start at 10:30</p><p id="zone">All times are local.</p></section></main>`,
    '#next:focus{outline:none}#times{color:#aaa}',[
      label('[data-search]','#age','search|搜索'),label('[name=org]','#age','Organization|机构',{human:'Organization'}),link('#calendar','#registration','Workshop schedule'),focus('#next','#prev'),contrast('#times','#zone'),
    ],{lang:'en',transport:'html'}),
  site('h5-application','表单','排练室申请',`<main><h1>排练室申请</h1><form><fieldset><legend>联络人</legend><label>姓名 <input id="person"></label><input autocomplete="email" name="reply"><input id="channel" type="text" name="data-2"><input id="room" aria-label="房间编号"></fieldset><section><p id="action">提交排练申请</p><button id="submit" aria-labelledby="unknown"></button><button id="reset">重填</button></section></form><p id="tiny" style="color:#aaa!important">审批最多三天</p><p id="rule">每周最多三次</p></main>`,
    '',[
      label('[name=reply]','#person','邮箱|email'),label('#channel','#person','回执编号',{human:'回执编号',expectAbstain:true}),oracle('label','#room','#person','房间编号',{negativeOnly:true}),aria('#submit','#reset','提交排练申请','action'),contrast('#tiny','#rule'),
    ],{transport:'html'}),
  site('h6-gallery','多文件网站','Graphite Gallery',`<main><h1>Graphite Gallery</h1><section><h2 id="hours">Archive opening hours</h2><div class="metadata"><span id="source">Donated in 1968</span></div><p id="inventory" class="metadata">Collection no. 7</p><p id="caption">On view in room 3</p><button id="panel">Show accession record</button><button id="support">Visitor support</button><form><textarea placeholder="Visitor notes" id="notes"></textarea><label>Subject <input id="subject"></label></form><nav><a id="jump" href="#hours"></a><a id="other" href="#hours">Visitor hours</a></nav></section></main>`,
    '.metadata{color:#aaa!important} #panel:focus-visible{outline:none}',[
      contrast('#source','#caption'),contrast('#inventory','#caption'),focus('#panel','#support'),label('#notes','#subject','Visitor notes|访客备注'),link('#jump','#other','Archive opening hours'),
    ],{lang:'en',entry:'archive/index.html',extraFiles:{'events.htm':'<!doctype html><html lang="en"><title>Events</title><link rel="stylesheet" href="/site.css"><main><h1>Events</h1><p id="inventory" class="metadata">Events inventory</p><button id="panel">Show event dates</button></main></html>'}}),
];
