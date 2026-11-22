#!/usr/bin/env node
// Build lightweight installable macOS DMG and Linux DEB packages on native runners.
// Base GGUF models are not included; the UI's model downloader remains available.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const platform = process.platform, arch = process.arch;
if (!['darwin','linux'].includes(platform) || !['x64','arm64'].includes(arch)) throw Error('Unsupported '+platform+'-'+arch);
const label = platform === 'darwin' ? 'macos' : 'linux';
const name = 'Zhidian-v'+version+'-'+label+'-'+arch+'-lite';
const builds = path.join(root,'dist','desktop-builds');
const output = path.join(root,'dist','installers');
const appDir = path.join(builds,'Zhidian-'+platform+'-'+arch);
function run(cmd,args) {
  console.log('>',cmd,...args);
  const result = spawnSync(cmd,args,{cwd:root,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status!==0) throw Error(cmd+' failed: '+result.status);
}
fs.rmSync(builds,{recursive:true,force:true});
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
const args = ['.','Zhidian','--platform='+platform,'--arch='+arch,
  '--out',builds,'--overwrite','--no-asar',
  '--ignore=^/(test|docs|dist|train|promo|build|hackathon|studio|huggingface|scripts|\\.github)'];
if(platform==='darwin') args.push('--extend-info','build/macos-info.plist','--app-bundle-id','org.zhidian.desktop');
run(path.join(root,'node_modules','.bin','electron-packager'),args);
const files = [];
if(platform==='darwin') {
  const app = path.join(appDir,'Zhidian.app');
  if(!fs.existsSync(path.join(app,'Contents','MacOS','Zhidian'))) throw Error('Mac app executable absent');
  // Ad-hoc signed, not Developer ID signed or notarized.
  run('codesign',['--force','--deep','--sign','-',app]);
  run('codesign',['--verify','--deep','--verbose=2',app]);
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'zhidian-dmg-'));
  try {
    fs.cpSync(app,path.join(stage,'Zhidian.app'),{recursive:true});
    fs.symlinkSync('/Applications',path.join(stage,'Applications'));
    const dmg=name+'.dmg';
    run('hdiutil',['create','-ov','-format','UDZO','-volname','Zhidian '+version,
      '-srcfolder',stage,path.join(output,dmg)]);
    run('hdiutil',['verify',path.join(output,dmg)]);
    files.push(dmg);
  } finally {fs.rmSync(stage,{recursive:true,force:true});}
  const zip=name+'.zip';
  run('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(output,zip)]);
  files.push(zip);
} else {
  const exe=path.join(appDir,'Zhidian');
  if(!fs.existsSync(exe)) throw Error('Linux executable absent');
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'zhidian-deb-'));
  try {
    const dest=path.join(stage,'usr','lib','zhidian');
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.cpSync(appDir,dest,{recursive:true});
    fs.chmodSync(path.join(dest,'Zhidian'),0o755);
    const sandbox=path.join(dest,'chrome-sandbox');
    if(fs.existsSync(sandbox)) fs.chmodSync(sandbox,0o4755);
    fs.mkdirSync(path.join(stage,'usr','bin'),{recursive:true});
    fs.symlinkSync('../lib/zhidian/Zhidian',path.join(stage,'usr','bin','zhidian'));
    const desktopDir=path.join(stage,'usr','share','applications');
    fs.mkdirSync(desktopDir,{recursive:true});
    fs.writeFileSync(path.join(desktopDir,'zhidian.desktop'),[
      '[Desktop Entry]','Type=Application','Name=Zhidian',
      'GenericName=Office Assistant','Exec=zhidian %U','Icon=accessories-text-editor',
      'Terminal=false','Categories=Office;Utility;','StartupWMClass=Zhidian',''
    ].join('\n'));
    const ctl=path.join(stage,'DEBIAN');
    fs.mkdirSync(ctl,{recursive:true});
    fs.writeFileSync(path.join(ctl,'control'),[
      'Package: zhidian','Version: '+version,'Section: office','Priority: optional',
      'Architecture: '+(arch==='x64'?'amd64':'arm64'),
      'Maintainer: ZhiDian contributors',
      'Depends: libc6 (>= 2.31), libgtk-3-0t64 | libgtk-3-0, libnss3, libgbm1, libasound2t64 | libasound2, libxss1',
      'Description: Zhidian desktop office assistant (lite)',
      ' Local office and PDF tools. AI model assets can be downloaded inside the app.',''
    ].join('\n'));
    const deb=name+'.deb';
    run('dpkg-deb',['--root-owner-group','--build',stage,path.join(output,deb)]);
    run('dpkg-deb',['--info',path.join(output,deb)]);
    files.push(deb);
  } finally {fs.rmSync(stage,{recursive:true,force:true});}
  const portable=name+'.tar.gz';
  run('tar',['-C',builds,'-czf',path.join(output,portable),path.basename(appDir)]);
  files.push(portable);
}
const sums=[];
for(const file of files) {
  const h=crypto.createHash('sha256');
  h.update(fs.readFileSync(path.join(output,file)));
  sums.push(h.digest('hex')+'  '+file);
}
fs.writeFileSync(path.join(output,'SHA256SUMS-'+label+'-'+arch+'.txt'),sums.join('\n')+'\n');
console.log('Created:',files.join(', '));
