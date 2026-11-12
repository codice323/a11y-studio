import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve('browser-extension-dist');
fs.mkdirSync(output,{recursive:true});
for(const name of ['manifest.json','popup.html','popup.css','popup.js','capture.js','background.js','bridge.js','screenshot.js'])fs.copyFileSync(path.join('browser-extension',name),path.join(output,name));
fs.copyFileSync('node_modules/axe-core/axe.min.js',path.join(output,'axe.min.js'));
console.log('浏览器扩展已准备：'+output);
