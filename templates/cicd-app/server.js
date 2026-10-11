const http=require('node:http');
const release=require('./release.json');
function createServer(){return http.createServer((req,res)=>{
  res.writeHead(req.url==='/health'&&release.unhealthy?503:200,{'content-type':'application/json'});
  res.end(JSON.stringify({release:release.id,healthy:!release.unhealthy}));
});}
if(require.main===module)createServer().listen(8080,'0.0.0.0');
module.exports={createServer};
