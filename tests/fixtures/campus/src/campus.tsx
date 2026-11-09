import React, {useEffect, useState, type FormEvent, type MouseEvent} from 'react';
import {sampleAudio, sampleVideo, captions} from './media';

const routes = {
  home: '首页', courses: '课程中心', enroll: '课程报名',
  resources: '学习资源', profile: '个人中心', help: '帮助与说明',
};
export type CampusPage = keyof typeof routes;
export const pages = Object.keys(routes) as CampusPage[];
export function pageFromPath(pathname: string): CampusPage {
  const name = pathname.split('/').filter(Boolean).at(-1)?.replace(/\.html$/, '');
  return pages.find(page => page === name) ?? 'home';
}
const courses = [
  {name:'开放科学工作坊', group:'研究技能', hours:6, description:'用实际数据学习可复现的研究流程。'},
  {name:'网页无障碍实践', group:'数字技能', hours:8, description:'练习语义结构、键盘操作和界面审查。'},
  {name:'学术英语写作', group:'语言学习', hours:4, description:'拆解论文摘要并练习同行反馈。'},
  {name:'校园地图与空间数据', group:'数字技能', hours:10, description:'从公开地图构建校园空间图层。'},
  {name:'文献检索入门', group:'研究技能', hours:3, description:'理解数据库检索、引用和阅读笔记。'},
  {name:'多语种沟通', group:'语言学习', hours:5, description:'通过分组演练提高校园沟通能力。'},
];
type Props = {initial:CampusPage; variant?:'react'|'zip'|'html'; image?:string};
export function Campus({initial, variant='react', image='/campus.png'}:Props) {
  const [page, setPage] = useState(initial);
  const dynamic = variant === 'react';
  const single = variant === 'html';
  const href = (target: CampusPage) => single ? '#section-' + target :
    dynamic ? target === 'home' ? '/' : '/' + target :
    initial === 'home' ? target === 'home' ? './index.html' : './pages/' + target + '.html' :
      target === 'home' ? '../index.html' : './' + target + '.html';
  const navigate = (event:MouseEvent<HTMLAnchorElement>, target:CampusPage) => {
    if (!dynamic || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    history.pushState({}, '', href(target));
    setPage(target);
    window.scrollTo(0,0);
  };
  useEffect(() => {
    if (!dynamic) return;
    const pop = () => setPage(pageFromPath(location.pathname));
    window.addEventListener('popstate',pop);
    return () => window.removeEventListener('popstate',pop);
  }, [dynamic]);
  const link = (target:CampusPage, name=routes[target]) => <a href={href(target)} onClick={event=>navigate(event,target)}>{name}</a>;
  return <>
    <a className="skip" href="#content">跳到主要内容</a>
    <header><div className="wrap top"><a className="brand" href={href('home')} onClick={event=>navigate(event,'home')}>青禾大学 <span>校园综合服务平台</span></a>
      <nav aria-label="主导航">{pages.map(item=><a key={item} aria-current={!single && item===page?'page':undefined}
        href={href(item)} onClick={event=>navigate(event,item)}>{routes[item]}</a>)}</nav></div></header>
    <main id="content" className="wrap">
      {pages.filter(item=>single || item===page).map(item=><section key={item} id={'section-'+item}>
        {item==='home'&&<Home image={image} courseLink={link('courses','浏览全部课程')} enrollLink={link('enroll','查看报名要求')} helpLink={link('help','帮助与说明')} />}
        {item==='courses'&&<Courses dynamic={dynamic} enroll={link('enroll','前往报名')} />}
        {item==='enroll'&&<Enroll dynamic={dynamic} />}
        {item==='resources'&&<Resources image={image} />}
        {item==='profile'&&<Profile dynamic={dynamic} />}
        {item==='help'&&<Help dynamic={dynamic} coursesLink={link('courses','前往课程中心')} />}
      </section>)}
    </main>
    <footer><div className="wrap">青禾大学教务与学习服务 · 演示数据　{link('help','使用帮助')}</div></footer>
  </>;
}

function Home({image,courseLink,enrollLink,helpLink}:{image:string;courseLink:React.ReactNode;enrollLink:React.ReactNode;helpLink:React.ReactNode}) {
  return <>
    <section className="hero"><div><p className="eyebrow">学习服务 · 秋季学期</p><h1>校园综合服务平台</h1>
      <p>查找课程、报名工作坊和管理你的学习计划。</p><p>{courseLink}　{enrollLink}</p></div>
      <img id="campus-hero" src={image} width="480" height="280" />
    </section>
    <section aria-labelledby="news"><h2 id="news">本周校园公告</h2>
      <p id="registration-note" className="muted">第二批通识课程报名将于周五开放。</p>
      <p id="live-announcement">离线公告：学习服务窗口工作日开放。</p>
      <button id="hero-help" type="button" commandfor="home-help" command="show-modal"><span aria-hidden="true">?</span></button>
      <dialog id="home-help" aria-labelledby="home-help-title"><h2 id="home-help-title">校园导航帮助</h2><p>通过主导航进入不同服务。</p><button commandfor="home-help" command="close">关闭校园导航帮助</button></dialog>
    </section>
    <section><h2>快捷查找</h2><div className="row"><input id="quick-search" type="search" /><span>{courseLink}</span></div></section>
    <section><h2>推荐课程</h2><div className="cards">{courses.slice(0,3).map(course=><article key={course.name}><p className="badge">{course.group}</p><h3>{course.name}</h3><p>{course.description}</p></article>)}</div></section>
    <section className="row" aria-label="服务操作"><a id="priority-link" tabIndex={3} href="#news">跳到公告</a>
      <button id="focusless" type="button">校历提醒</button><button id="save-reminder" type="button" aria-describedby="missing-reminder-description">保存提醒</button>
      <a id="tiny-target" href="#news" aria-label="公告索引">·</a>{helpLink}</section>
  </>;
}

function Courses({dynamic,enroll}:{dynamic:boolean;enroll:React.ReactNode}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('全部');
  const [sort, setSort] = useState('推荐');
  const [count, setCount] = useState(3);
  const visible = courses.filter(course=>(group==='全部'||course.group===group) && course.name.includes(query));
  if (sort==='学时从少到多') visible.sort((a,b)=>a.hours-b.hours);
  return <><h1>课程中心</h1><p>按主题选择适合本学期的课程。</p>
    {dynamic ? <div className="filters">
      <label>搜索课程 <input type="search" value={query} onChange={event=>setQuery(event.target.value)} /></label>
      <label>筛选分类 <select value={group} onChange={event=>setGroup(event.target.value)}>{['全部','研究技能','数字技能','语言学习'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label>排序 <select value={sort} onChange={event=>setSort(event.target.value)}><option>推荐</option><option>学时从少到多</option></select></label>
    </div> : <p>此离线目录展示全部课程。</p>}
    <div className="cards">{visible.slice(0,dynamic?count:visible.length).map(course=><article key={course.name}>
      <p className="badge">{course.group} · {course.hours} 学时</p><h2>{course.name}</h2><p>{course.description}</p>{enroll}</article>)}</div>
    {dynamic&&visible.length>count&&<button type="button" onClick={()=>setCount(count+3)}>加载更多课程</button>}
  </>;
}

function Enroll({dynamic}:{dynamic:boolean}) {
  const [result,setResult]=useState('');
  const submit=(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    setResult(String(data.get('email')).endsWith('@campus.example')?'演示报名已保存。':'请使用校园邮箱。');
  };
  return <><h1>课程报名</h1><p>演示报名仅更新页面，不向外部发送数据。</p>
    <form onSubmit={dynamic?submit:undefined}>
      <label htmlFor="student-name">姓名</label><input id="student-name" name="name" autoComplete="name" required />
      <label htmlFor="student-email">邮箱</label><input id="student-email" name="email" type="email" required />
      <label htmlFor="course-choice">课程</label><select id="course-choice" name="course" required><option value="">请选择</option>{courses.map(course=><option key={course.name}>{course.name}</option>)}</select>
      <fieldset><legend>参加方式</legend><label><input type="radio" name="attendance" value="on" defaultChecked /> 到场</label><label><input type="radio" name="attendance" value="remote" /> 线上</label></fieldset>
      <label><input type="checkbox" name="consent" required /> 我确认使用演示资料</label>
      {dynamic ? <button type="submit">检查报名</button> : <p>此版本仅可查看字段与原生必填约束。</p>}
      {result&&<p id="enrollment-result">{result}</p>}
    </form></>;
}
function Resources({image}:{image:string}) {
  return <><h1>学习资源</h1><article><h2>校园导览资料</h2><img src={image} width="480" height="280" alt="青禾大学校园示意图：教学楼、树木和太阳" />
    <p>从服务大厅步行经过图书馆，即可抵达教学楼。</p><button type="button" aria-label="收藏校园导览">☆</button></article>
    <article><h2>一分钟认识学习服务</h2><p>音频包含固定提示音。视频展示蓝色导览卡与橙色圆标的移动。</p>
      <audio controls preload="none" src={sampleAudio} aria-label="校园服务提示音" />
      <video controls preload="none" width="320" height="180" poster={image} src={sampleVideo} aria-label="校园导览动画">
        <track kind="captions" srcLang="zh" label="中文" src={captions} default />
      </video><p>文字说明：橙色圆标从左向右移动。视频为无声演示。</p></article></>;
}
function Profile({dynamic}:{dynamic:boolean}) {
  const [tab,setTab]=useState('学习概览');
  const [name,setName]=useState('体验学生');
  return <><h1>个人中心</h1><div className="profile">
    <aside><h2>我的服务</h2>{dynamic?<div role="tablist" aria-label="个人中心标签">
      {['学习概览','我的设置'].map(item=><button key={item} role="tab" id={'tab-'+item} aria-controls="profile-panel" aria-selected={tab===item} type="button" onClick={()=>setTab(item)}>{item}</button>)}
    </div>:<a href="#profile-panel">学习概览</a>}</aside>
    <section id="profile-panel" role={dynamic?'tabpanel':undefined} aria-labelledby={dynamic?'tab-'+tab:undefined}>
      <h2>{tab}</h2><p>当前昵称：{name}</p>
      <button type="button" commandfor="profile-editor" command="show-modal">编辑资料</button>
      <dialog id="profile-editor" aria-labelledby="profile-dialog-title"><h2 id="profile-dialog-title">编辑资料</h2>
        <label>演示昵称 <input defaultValue={name} onChange={dynamic?event=>setName(event.target.value):undefined} /></label>
        <button type="button" commandfor="profile-editor" command="close">关闭编辑资料</button></dialog>
    </section></div></>;
}
function Help({dynamic,coursesLink}:{dynamic:boolean;coursesLink:React.ReactNode}) {
  const [sent,setSent]=useState(false);
  return <><h1>帮助与说明</h1><section><h2>常见问题</h2>
    <details><summary>如何查询课程？</summary><p>{coursesLink}，选择对应主题。</p></details>
    <details><summary>报名会发送数据吗？</summary><p>体验版中的演示数据只在页面本地显示。</p></details>
    </section><section><h2>反馈表单</h2><form onSubmit={dynamic?event=>{event.preventDefault();setSent(true);}:undefined}>
      <label>反馈内容 <textarea required rows={3} /></label>{dynamic&&<button>保存本地反馈</button>}{sent&&<p role="status">反馈已保存在本次体验中。</p>}
    </form></section></>;
}
