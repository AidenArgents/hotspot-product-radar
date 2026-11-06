// 对用户现有 HTML 做一次接入改造；不另建线上页面，也不复制倒排算法到后台。
import fs from "node:fs";
const file = process.argv[2];
if (!file) throw new Error("请提供原看板HTML文件路径");
let html = fs.readFileSync(file, "utf8");
if (html.includes("function buildReminderFeed()")) throw new Error("此页面已接入提醒数据");
function replace(from, to) {
  if (!html.includes(from)) throw new Error(`原页面结构已改变：${from.slice(0, 70)}`);
  html = html.replace(from, to);
}
const integration = String.raw`
// 只导出公开计划数据；机器人凭据及提醒发送均在本机后台。
function buildReminderFeed(){
 generateEvents();
 var nodes=[],rs=activeRoutes();
 events.forEach(function(e){
  var supply=e.supply||e.category==='supply';
  if(!supply&&eventTier(e)==='none')return;
  rs.forEach(function(r){
   var ms=supply?supplyMilestone(e,r):milestone(e,r);
   ['start','finish','depart'].forEach(function(stage){
    nodes.push({id:e.id+'|route-'+r.index+'|'+stage,event_id:e.id,event_name:e.name,
     event_date:e.date,estimated:e.status==='estimated',route_id:'route-'+r.index,route_name:r.name,
     stage:stage,stage_name:stageNames[stage],due_date:ms[stage]});
   });
  });
 });
 return {schema_version:1,title:'美国电商备货日历',action_timezone:'Asia/Shanghai',
  generated_at:new Date().toISOString(),event_count:events.length,route_count:rs.length,nodes:nodes};
}
function reminderJson(){return JSON.stringify(buildReminderFeed()).replace(/</g,function(){return String.fromCharCode(92)+'u003c'})}
function refreshReminderFeed(){
 var node=el('calendar-reminder-data');
 if(!node){node=document.createElement('script');node.id='calendar-reminder-data';node.type='application/json';document.head.appendChild(node)}
 node.textContent=reminderJson();
}
`;
replace("function generateEvents(){", integration + "\nfunction generateEvents(){");
replace("return JSON.stringify([state.custom,state.edits,state.hidden,state.tba,state.tierAssignments]);",
  "return JSON.stringify([state.custom,state.edits,state.hidden,state.tba,state.tierAssignments,state.pick,state.prep,state.buffer,state.tierDays,state.supplyPlan,state.routes]);");
replace("var savedFileHandle=null;", "var savedFileHandle=null;\nvar lastBusinessSignature=eventRecordSignature();");
replace("● 有新增或修改的事件，尚未写入 HTML", "● 备货方案有修改，保存HTML并发布后后台才会同步");
replace("修改后自动重新倒排；无需保存新的 HTML。", "修改后自动重新倒排；保存HTML并发布后，后台提醒才会采用新方案。");
replace("设置保存在当前浏览器缓存；新增节日可保存到 HTML 文件后分享。", "本地修改先保存在浏览器；保存HTML并发布到原链接后，后台会在每日提醒前或手动同步时读取。后台按北京时间提醒。");
replace("function save(){", "function save(){\n lastBusinessSignature=eventRecordSignature();");
replace("function updateAndRender(){save();render()}", "function updateAndRender(){if(eventRecordSignature()!==lastBusinessSignature)state._eventDirty=true;save();render();refreshReminderFeed()}");
replace("clone.querySelector('head').appendChild(tag);", "clone.querySelector('head').appendChild(tag);\n  var oldFeed=clone.querySelector('#calendar-reminder-data');if(oldFeed)oldFeed.remove();\n  var feed=document.createElement('script');feed.id='calendar-reminder-data';feed.type='application/json';feed.textContent=reminderJson();clone.querySelector('head').appendChild(feed);");
replace("initControls();bind();render();renderSaveStatus();", "initControls();bind();render();renderSaveStatus();refreshReminderFeed();");
replace("<div class=\"topright\">", "<div class=\"topright\" title=\"修改方案后保存HTML并发布到原链接；后台每天发送前同步，按北京时间提醒。分类与显示筛选仅影响看板展示。\">");
fs.writeFileSync(file, html, "utf8");
console.log("已为原页面接入公开提醒计划；发布前需将页面生成的calendar-reminder-data写入HTML。");
