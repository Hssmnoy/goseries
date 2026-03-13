process.env.NODE_TLS_REJECT_UNAUTHORIZED="0"

const axios=require("axios")
const cheerio=require("cheerio")
const fs=require("fs")
const https=require("https")
const { execSync } = require("child_process")
const categories = require("./categories")
const agent=new https.Agent({rejectUnauthorized:false})

const DOMAIN="https://goseries4k.com"

const TEST_MODE = false

let progress={
show:null,
episodeIndex:0
}

if(fs.existsSync("progress.json")){

try{

progress=JSON.parse(fs.readFileSync("progress.json"))

}catch(e){

console.log("PROGRESS READ ERROR")

}

}

function saveProgress(show,episodeIndex){

progress.show=show
progress.episodeIndex=episodeIndex
progress.updated=new Date().toISOString()

fs.writeFileSync(
"progress.json",
JSON.stringify(progress,null,2)
)
}

function gitCommit(){

try{

execSync('git config --global user.name "github-actions"')
execSync('git config --global user.email "actions@github.com"')

execSync("git add *.json *.m3u progress.json")

execSync('git commit -m "crawler progress"')

execSync("git pull --rebase")

execSync("git push")

console.log("GIT COMMIT")

}catch(e){

console.log("GIT ERROR")
console.log(e.message)

}

}

async function load(url){

const res=await axios.get(url,{
httpsAgent:agent,
timeout:15000,
headers:{
"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
"Referer":DOMAIN,
"X-Requested-With":"XMLHttpRequest",
"Accept":"text/html,application/xhtml+xml"
}
})

return res.data
}

function findM3U8(html){

const m=html.match(/https?:\/\/[^"' ]+\.(m3u8|txt)[^"' ]*/)

if(m) return m[0]

return null
}

function decodeVideoSources(html){

const scriptRegex=/<script[^>]*>([\s\S]*?)<\/script>/gi
let match

while((match=scriptRegex.exec(html))!==null){

const script=match[1]

if(!script.includes("videoSources")) continue

const server=script.match(/"videoServer":"(\d+)"/)
const source=script.match(/"videoSources":\[\{"file":"([^"]+)"/)
const host=script.match(/"hostList":(\{.*?\})/)

if(server && source && host){

const videoServer=server[1]
let videoFile=source[1]

let hostList

try{
hostList=JSON.parse(host[1])
}catch(e){
continue
}

if(hostList[videoServer]){

let domain=hostList[videoServer][0]

domain=domain.replace(/[\[\]']/g,"").trim()

let url=videoFile.replace(
/https:\\\/\\\/\d+\\\/cdn\\\/hls\\\//,
"https://"+domain+"/api/files/"
)

url=url.replace(/\\\//g,"/")

return url

}

}

}

return null
}

async function getIframeVideo(url,depth=0){

try{

if(depth>5){
console.log("IFRAME TOO DEEP")
return null
}

const html=await load(url)

console.log("IFRAME URL",url)
//console.log("IFRAME HTML START")
//console.log(html.slice(0,1200))
//console.log("IFRAME HTML END")

const direct=findM3U8(html)

if(direct) return direct

const jw = html.match(/file:\s*"([^"]+\.m3u8[^"]*)"/)

if(jw) return jw[1]

const decoded=decodeVideoSources(html)
if(decoded) return decoded

const iframe=html.match(/<iframe[^>]+src="([^"]+)"/)

if(iframe){

return await getIframeVideo(iframe[1],depth+1)

}

}catch(e){}

return null
}

async function getVideo(url){

try{

const res = await axios.get(url,{
httpsAgent:agent,
timeout:15000,
headers:{
"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
"Referer":DOMAIN + "/",
"Origin":DOMAIN,
"X-Requested-With":"XMLHttpRequest",
"Accept":"*/*"
}
})

const html = res.data

const server = html.match(/data-id="(https?:\/\/[^"]+)"/)

if(server){
return await getIframeVideo(server[1])
}

const iframe = html.match(/<iframe[^>]+(?:src|data-src)="([^"]+)"/)

if(iframe){
return await getIframeVideo(iframe[1])
}

}catch(e){

console.log("VIDEO ERROR",e.message)

}

return null

}

async function getEpisodes(url){

const html = await load(url)
//console.log("EP HTML SAMPLE")
//console.log(html.slice(0,2000))

const $ = cheerio.load(html)

const postId = html.match(/postid-(\d+)/)

let POST_ID = null

if(postId){
POST_ID = postId[1]
}

let eps = []

// DEBUG หา EP ID
$(".mp-ep-btn").each((i,el)=>{

    const id = $(el).attr("data-id")

    if(id){

        //console.log("EP DATA-ID:",id)

        eps.push({
            name: $(el).text().trim(),
            id: id
        })

    }

})

return { eps, POST_ID }

}

async function scanCategory(path){

let shows=[]
let page=1

while(true){
if(TEST_MODE && page>1){
break
}
let url

if(page===1){

url=DOMAIN+path

}else{

url=DOMAIN+path+"page/"+page+"/"

}

console.log("SCAN",url)

try{

const html=await load(url)

const $=cheerio.load(html)

let found=0

$("article a, .post a, h2 a").each((i,el)=>{

const link=$(el).attr("href")

if(link &&
link.startsWith(DOMAIN) &&
!link.includes("/category/") &&
!link.includes("/page/")
){

shows.push(link)
found++

}

})

if(found===0){

console.log("END CATEGORY",path)
break

}

page++

}catch(e){

break

}

}

return [...new Set(shows)]

}

async function run(){

const cats = categories

console.log("CATEGORIES",categories.length)

let scannedShows=[]

let usedVideos=[]

let jsonOutput={}

let movieCount = 0
  
let resume = progress.show ? false : true

for(const cat of cats){

const group = cat.slug
console.log("CATEGORY",group)

const jsonFile="goseries4k_"+group+".json"

if(fs.existsSync(jsonFile)){

try{

jsonOutput[group]=JSON.parse(fs.readFileSync(jsonFile))

console.log("LOAD OLD JSON",jsonOutput[group].length)

}catch(e){

jsonOutput[group]=[]

}

}else{

jsonOutput[group]=[]

}

const file="iptv_"+group+".m3u"

if(!fs.existsSync(file)){
fs.writeFileSync(file,"#EXTM3U\n\n")
}

const shows=await scanCategory(cat.url.replace(DOMAIN,""))

for(let si=0; si<shows.length; si++){

const show = shows[si]

if(TEST_MODE && si>0){
break
}

if(!resume){

if(show===progress.show){

resume=true

}else{

continue

}

}

try{

console.log("SHOW",show)

const html=await load(show)

const $=cheerio.load(html)

let title=$("meta[property='og:title']").attr("content") || show
title=title.replace(" - goseries4k","")

// ตัดข้อความเกิน
title = title
.replace(/ดูซีรี่ย์/g,"")
.replace(/EP\..*/g,"")
.replace(/ตอนที่.*/g,"")
.trim()

let poster=$("meta[property='og:image']").attr("content") || ""

let movie={
  title:title,
  image:poster,
  episodes:[]
}

let oldEpisodes = []

const oldMovie = jsonOutput[group].find(m=>m.title===title)

if(oldMovie){

oldEpisodes = oldMovie.episodes.map(e=>e.name)

movie.episodes.push(...oldMovie.episodes)

console.log("OLD EP",oldEpisodes.length)

}

if(scannedShows.includes(show)) continue

scannedShows.push(show)

let data = await getEpisodes(show)
let episodes = data.eps
let POST_ID = data.POST_ID

console.log("EPISODES",episodes.length)

episodes.sort((a,b)=>{
return parseInt(a.id) - parseInt(b.id)
})

if(episodes.length===0){

const post=html.match(/postid-(\d+)/)

if(post){
episodes=[show]
}

}

for(let i=0;i<episodes.length;i++){

if(TEST_MODE && i>5){
break
}

if(show===progress.show && i<progress.episodeIndex){
continue
}

const ep = episodes[i]

saveProgress(show,i)

const cacheMatch = html.match(/window\.miru_ep_cache\s*=\s*(\{[\s\S]*?\});/)

if(!cacheMatch){
console.log("miru_ep_cache NOT FOUND")
continue
}

const epCache = JSON.parse(cacheMatch[1])

//console.log("EP CACHE KEYS", Object.keys(epCache).length)

const epHtml = epCache[ep.id]

//console.log("CHECK EP", ep.id, epHtml ? "FOUND" : "MISS")

if(!epHtml){
console.log("EP CACHE NOT FOUND",ep.id)
continue
}

const iframe = epHtml.match(/iframe src="([^"]+)/)

if(!iframe){
console.log("IFRAME NOT FOUND",ep.id)
continue
}

const video = await getIframeVideo(iframe[1])

if(video){

//if(usedVideos.includes(video)){
//continue
//}

//usedVideos.push(video)

console.log("VIDEO",video)

const epNumber = ep.name.match(/\d+/)

let epName = "EP"+(i+1)

if(epNumber){
  epName = "EP"+epNumber[0]
}
if(oldEpisodes.includes(epName)){
console.log("SKIP OLD",epName)
continue
}
movie.episodes.push({
  name:epName,
  servers:[
    {
      name:"goseries4k",
      url:video
    }
  ]
})

const line=`#EXTINF:-1 tvg-name="${title} ${epName}" tvg-logo="${poster}" group-title="${group}",${title} ${epName}\n${video}\n\n`

fs.appendFileSync(file,line)

}
    if(movie.episodes.length>0){

const index = jsonOutput[group].findIndex(m=>m.title===title)

if(index!==-1){

jsonOutput[group][index]=movie
console.log("UPDATE JSON",title)

}else{

jsonOutput[group].push(movie)
console.log("NEW JSON",title)

}

fs.writeFileSync(
"goseries4k_"+group+".json",
JSON.stringify(jsonOutput[group],null,2)
)

if(!TEST_MODE){
gitCommit()
}

}
}
}catch(e){

console.log("SHOW ERROR",e.message)

}

}

}

for(const group in jsonOutput){

const file="goseries4k_"+group+".json"

fs.writeFileSync(
file,
JSON.stringify(jsonOutput[group],null,2)
)

console.log("JSON CREATED",file)

}

console.log("JSON CREATED GROUPS",Object.keys(jsonOutput).length)

console.log("DONE IPTV CREATED")

}


run()
