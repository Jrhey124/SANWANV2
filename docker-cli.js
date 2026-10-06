const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findDockerCommand(platform=os.platform(),env=process.env,exists=fs.existsSync){
  const join=platform==='win32'?path.win32.join:path.posix.join;
  const candidates=platform==='win32'
    ?[join(env.LOCALAPPDATA??'','Programs','DockerDesktop','resources','bin','docker.exe'),join(env.ProgramFiles??'C:\\Program Files','Docker','Docker','resources','bin','docker.exe'),'docker.exe']
    :['docker'];
  return candidates.find(command=>command==='docker.exe'||command==='docker'||exists(command))??(platform==='win32'?'docker.exe':'docker');
}

module.exports={findDockerCommand};
