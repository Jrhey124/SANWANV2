const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('./server');
const release=require('./release.json');
test('release must pass CI',()=>assert.equal(release.failTests,false));
test('health endpoint reports release mode',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status,release.unhealthy?503:200);
    assert.deepEqual(await response.json(),{release:release.id,healthy:!release.unhealthy});
  }finally{await new Promise(resolve=>server.close(resolve));}
});
