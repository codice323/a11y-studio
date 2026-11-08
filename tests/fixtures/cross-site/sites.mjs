// Independent, original synthetic pages. Oracle annotations below are used only by
// the benchmark evaluator. They are never sent to the app or model.
const page = (title, css, body, lang = 'zh-CN') =>
  `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="${css}"><body>${body}</body></html>`;
const pair = (kind, target, control, expected, options = {}) => ({kind, target, control, expected, ...options});
const common = 'body{background:#fff;color:#202530;font:16px Arial;margin:28px} img{width:140px;height:auto} button{padding:6px 10px} .low{color:#a7a7a7} .no-focus:focus{outline:none;box-shadow:none} .has-focus:focus-visible{outline:3px solid #244787;outline-offset:2px}';
export const sites = [
  { id:'corporate', category:'企业官网', entry:'index.html', css:'styles/brand.css',
    html:page('岚石工程', 'styles/brand.css', `<header><nav><a href="#team">工程团队</a></nav></header><main id="team"><h1>岚石工程</h1>
      <section><h2>施工影像</h2><div><figure><img id="bridge" src="media/p1.png"><figcaption>2026 现场影像</figcaption></figure><img id="divider" src="media/p1.png" alt=""></div></section>
      <section><h2>反馈</h2><form><div><input id="reply-to" type="email"></div><div><label for="phone">电话</label><input id="phone" type="tel"></div></form></section>
      <aside><p id="hours" class="low">工作日开放</p><p id="address">海港工业区</p></aside>
      <section><h2>客服</h2><button id="call-hours" class="no-focus">查看值班表</button><button id="route" class="has-focus">查看路线</button></section></main>`),
    style:common+' main{max-width:740px} figure{margin:0} section{margin-block:12px}',
    images:[['media/p1.png','bridge']],
    pairs:[pair('alt','#bridge','#divider','桥|bridge'),pair('label','#reply-to','#phone','邮箱|email'),pair('contrast','#hours','#address'),pair('focus','#call-hours','#route')] },
  { id:'shop', category:'电商页面', entry:'catalog/index.html', css:'theme/catalog.css',
    html:page('Harbor Market','../theme/catalog.css',`<main><h1>Harbor Market</h1><ul>
      <li><article><h2>Desk collection</h2><figure><picture><source srcset="../media/x4.webp" type="image/webp"><img id="item-image" src="../media/x4.jpg"></picture><figcaption>Featured item</figcaption></figure>
      <form action="/basket"><button id="buy" type="submit"><span aria-hidden="true">＋</span></button></form><button id="details">Item details</button></article></li>
      <li><article><h2>Other items</h2><img id="second" src="../media/x4.jpg" alt="Blue desk lamp"><p class="low"><span>Stock information</span></p><p id="stock-good">Shipping information</p></article></li>
      </ul><aside><button id="coupon" class="no-focus">Show offer</button><button id="cart" class="has-focus">Open basket</button></aside></main>`,'en'),
    style:common+' ul{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding-left:25px} article{padding:12px;border:1px solid #aab}',
    images:[['media/x4.jpg','lamp'],['media/x4.webp','lamp']],
    pairs:[pair('alt','#item-image','#second','灯|lamp'),pair('button','#buy','#details','篮|购物|加入|basket|cart|add',{human:'Add to basket'}),pair('contrast','.low span','#stock-good'),pair('focus','#coupon','#cart')] },
  { id:'news', category:'新闻页面', entry:'story.html', css:'edition.css',
    html:page('北岸日报','edition.css',`<header><a href="#story">北岸日报</a></header><main><article id="story"><h1>周末公共交通现场</h1>
      <figure><img id="photo" src="k7.gif"><figcaption>记者在现场拍摄</figcaption></figure><img id="ornament" src="k7.gif" alt="">
      <p class="low" id="byline">公共事务组 · 08:30</p><p id="lead">周末运营计划已发布。</p>
      <section aria-label="读者工具"><h2>读者工具</h2><p id="bookmark-word">收藏文章</p><button id="bookmark" aria-labelledby="bookmark-old"><span aria-hidden="true">★</span></button><button id="print" aria-label="打印文章"><span aria-hidden="true">■</span></button></section></article></main>`),
    style:common+' article{max-width:42rem;margin:auto} .low{font-size:14px}',
    images:[['k7.gif','train']],
    pairs:[pair('alt','#photo','#ornament','列车|火车|地铁|车厢|train'),pair('contrast','#byline','#lead'),pair('aria','#bookmark','#print','收藏文章',{ref:'bookmark-word'})] },
  { id:'education', category:'教育网站', entry:'campus/index.html', css:'campus/assets/ui.css',
    html:page('Open Study','assets/ui.css',`<main><h1>Open Study</h1><nav aria-label="Course navigation"><button id="course" class="no-focus">Course index</button><button id="help" class="has-focus">Help center</button></nav>
      <section><h2>Course directory</h2><form><div><span>Course topic:</span><input type="text" data-field="topic"></div><div><label>Student ID <input id="student"></label></div><button>Find courses</button></form></section>
      <section><h2>Course materials</h2><details><summary>Handouts</summary><p>Introductory materials</p></details>
      <p id="download-word">Download lesson notes</p><button id="download" type="button" aria-labelledby="missing-download"><span aria-hidden="true">↓</span></button>
      <button id="calendar" aria-label="Open calendar"><span aria-hidden="true">■</span></button></section></main>`,'en'),
    style:common+' main{display:flex;flex-direction:column;gap:10px} section{border-left:3px solid #adc;padding:8px}',
    images:[],
    pairs:[pair('label','[data-field=topic]','#student','Course topic'),pair('aria','#download','#calendar','Download lesson notes',{ref:'download-word'}),pair('focus','#course','#help')] },
  { id:'forms', category:'表单系统', entry:'intake.htm', css:'forms.css',
    html:page('预约登记','forms.css',`<main><h1>预约登记</h1><form aria-label="预约" action="/submit">
      <fieldset><legend>联系与登记</legend><div><input id="callback" type="text" autocomplete="tel"></div>
      <div><input id="refcode" type="text"></div><div><label for="date">日期</label><input id="date" type="date"></div></fieldset>
      <fieldset><legend>确认</legend><div><button id="send" type="submit"></button><button id="clear" type="reset">清空表单</button></div>
      <p id="confirm-word">保存并提交预约</p><button id="send-alt" type="submit" aria-labelledby="deleted-ref"><span aria-hidden="true">✓</span></button><button id="save-draft" type="button" aria-label="保存草稿"><span aria-hidden="true">○</span></button></fieldset>
      </form></main>`),
    style:common+' fieldset{display:grid;gap:10px;margin:12px 0} #send{min-width:30px;min-height:25px}',
    images:[],
    pairs:[pair('label','#callback','#date','电话|phone'),pair('label','#refcode','#date','预约登记编号',{human:'预约登记编号',expectAbstain:true}),pair('button','#send','#clear','提交|预约|submit'),pair('aria','#send-alt','#save-draft','保存并提交预约',{ref:'confirm-word'})] },
];
