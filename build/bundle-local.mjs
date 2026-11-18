// Build-time only. The installed application never downloads these assets on first launch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MODELS, RUNTIME, SOURCES, runtimeAsset, localName } from '../src/main/local/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = path.join(root, 'models');
const verifyOnly = process.argv.includes('--verify-only');
const source = SOURCES[process.env.ZHIDIAN_BUILD_SOURCE || 'huggingface'];
if (!source) throw new Error('Unknown ZHIDIAN_BUILD_SOURCE');
fs.mkdirSync(modelDir, {recursive:true});
async function sha256(file) {
  const hash=crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function matches(file, info) {
  return fs.existsSync(file) && fs.statSync(file).size === info.size && await sha256(file) === info.sha256;
}
function run(command, args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
  });
}
async function acquire(file, info, url) {
  if (await matches(file,info)) return;
  if (verifyOnly) throw new Error(`Missing or invalid offline asset: ${path.basename(file)}`);
  const partial=file+'.part';
  if (!await matches(partial,info)) await run('curl',['--fail','--location','--retry','4','--connect-timeout','30','--continue-at','-','--output',partial,url]);
  if (!await matches(partial,info)) throw new Error(`SHA256 mismatch: ${path.basename(file)}`);
  fs.renameSync(partial,file);
}

const argVal = (flag) => {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (hit) return hit.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--') ? process.argv[idx + 1] : '';
};
const targetPlatform = argVal('--platform') || process.platform;
const targetArch = argVal('--arch') || process.arch;

const manifest={version:'0.5.0',format:1,models:[],runtime:{tag:RUNTIME.tag,platform:targetPlatform,arch:targetArch},officeAdapter:null};
for (const model of MODELS) {
  for (const file of model.files) {
    const name=localName(file);
    console.log(`Verify bundled ${name}`);
    await acquire(path.join(modelDir,name),file,source.url(model,file));
    manifest.models.push({model:model.id,name,role:file.role,size:file.size,sha256:file.sha256,repo:model.repo,revision:model.revision});
  }
}

// Adapter provenance is pinned in source together with the locally trained adapter blob.
const adapterManifest=path.join(modelDir,'office-adapter.json');
if (!fs.existsSync(adapterManifest)) throw new Error('office-adapter.json is required; do not label an untrained package as the office LoRA build.');
const adapter=JSON.parse(fs.readFileSync(adapterManifest,'utf8'));
if (adapter.name!=='office-small-lora.gguf' || !Number.isSafeInteger(adapter.size) || !/^[a-f0-9]{64}$/.test(adapter.sha256)) throw new Error('Invalid office adapter manifest');
if (!await matches(path.join(modelDir,adapter.name),adapter)) throw new Error('The trained office adapter does not match its pinned manifest');
manifest.officeAdapter=adapter;

const asset=runtimeAsset(targetPlatform,targetArch);
if (!asset) throw new Error(`Unsupported packaging platform: ${targetPlatform}-${targetArch}`);
const runtimeDir=path.join(modelDir,'runtime',`${targetPlatform}-${targetArch}`);
const runtimeManifest=path.join(runtimeDir,'verified-runtime.json');
let verified=false;
if (fs.existsSync(runtimeManifest)) {
  const info=JSON.parse(fs.readFileSync(runtimeManifest,'utf8'));
  verified=info.archiveSha256===asset.sha256 && info.files?.length>0;
  for (const file of info.files||[]) {
    if (path.basename(file.name)!==file.name || !await matches(path.join(runtimeDir,file.name),file)) verified=false;
  }
  if (info.symlinks) {
    for (const link of info.symlinks) {
      const lp=path.join(runtimeDir,link.name);
      try { if (fs.readlinkSync(lp)!==link.target) verified=false; } catch { verified=false; }
    }
  }
}
if (!verified) {
  if (verifyOnly) throw new Error('Bundled runtime has not passed archive/file verification');
  const archive=path.join(modelDir,asset.name);
  await acquire(archive,asset,RUNTIME.url(asset.name));
  const unpack=fs.mkdtempSync(path.join(modelDir,'.runtime-'));
  try {
    if (archive.endsWith('.zip') && process.platform !== 'win32') {
      await run('7z',['x','-y',`-o${unpack}`,archive]).catch(()=>run('tar',['-xf',archive,'-C',unpack]));
    } else {
      await run('tar',['-xf',archive,'-C',unpack]);
    }
    const files=[];
    function visit(dir) { for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {const file=path.join(dir,entry.name);if(entry.isDirectory())visit(file);else files.push(file);} }
    visit(unpack);
    const server=files.find(file=>path.basename(file)===(targetPlatform==='win32'?'llama-server.exe':'llama-server'));
    if (!server) throw new Error('Verified archive has no llama-server');
    fs.rmSync(runtimeDir,{recursive:true,force:true});
    fs.mkdirSync(runtimeDir,{recursive:true});
    const records=[], symlinks=[];
    const serverDir=path.dirname(server);
    for(const file of fs.readdirSync(serverDir,{withFileTypes:true})) {
      const sourceFile=path.join(serverDir,file.name);
      const destFile=path.join(runtimeDir,file.name);
      if (file.isSymbolicLink()) {
        const linkTarget=fs.readlinkSync(sourceFile);
        if (path.isAbsolute(linkTarget) || linkTarget.includes('..') || path.basename(linkTarget)!==linkTarget) continue;
        fs.symlinkSync(linkTarget,destFile);
        symlinks.push({name:file.name,target:linkTarget});
        continue;
      }
      if (!file.isFile()) continue;
      fs.copyFileSync(sourceFile,destFile);
      if (targetPlatform!=='win32' && file.name==='llama-server') fs.chmodSync(destFile,0o755);
      records.push({name:file.name,size:fs.statSync(sourceFile).size,sha256:await sha256(sourceFile)});
    }
    fs.writeFileSync(runtimeManifest,JSON.stringify({archive:asset.name,archiveSha256:asset.sha256,files:records,symlinks},null,2)+'\n');
  } finally {
    const expectedPrefix=path.resolve(modelDir)+path.sep;
    if (!path.resolve(unpack).startsWith(expectedPrefix)) throw new Error('Refusing unsafe build cleanup');
    fs.rmSync(unpack,{recursive:true,force:true});
  }
  fs.unlinkSync(archive);
}
manifest.runtime.files=JSON.parse(fs.readFileSync(runtimeManifest,'utf8')).files;
fs.writeFileSync(path.join(modelDir,'bundle-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Offline bundle verified (${targetPlatform}-${targetArch}): small + large + office LoRA + runtime. No first-launch model download.`);
