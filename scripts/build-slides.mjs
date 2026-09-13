import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
const photo=await readFile('web/assets/nyc-apartments.jpg');
let evidence={};try{evidence=JSON.parse(await readFile('.local/ui-run.json','utf8'));}catch{}
let html=(await readFile('web/slideshow.template.html','utf8')).replace('__PHOTO__','data:image/jpeg;base64,'+photo.toString('base64')).replace('__EVIDENCE__',JSON.stringify(evidence).replace(/</g,'\\u003c'));
await writeFile('web/slideshow.html',html);await mkdir('output',{recursive:true});await copyFile('web/slideshow.html','output/signed-email-rent-feed.html');console.log('Built 13-slide self-contained HTML presentation.');
