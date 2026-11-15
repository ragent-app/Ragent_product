import pathlib,json,os,subprocess,sys,hashlib,argparse
base=pathlib.Path(__file__).parent
parser=argparse.ArgumentParser(description="Offline actual bound-controller JVM fixture; Android/RTC boundaries substituted")
parser.add_argument('--classpath-manifest',type=pathlib.Path,required=True)
parser.add_argument('--output',type=pathlib.Path,required=True)
args=parser.parse_args()
root=base.parents[1]
stage=args.output.resolve(); stage.mkdir(exist_ok=False)
cp=json.loads(args.classpath_manifest.read_text(encoding='utf-8-sig'))
def put(name,text):
 p=stage/name;p.write_text(text,encoding='utf-8');return p
sources=[]
sources.append(put('Application.kt','package android.app\nopen class Application\n'))
sources.append(put('AndroidNetworkMonitor.kt','''package com.andysagent.ragent.core.network
import android.app.Application
class AndroidNetworkMonitor(application: Application): NetworkMonitor {
 override val isOnline = true
 override fun register(callback: NetworkMonitor.Callback) {}
 override fun unregister() {}
}
'''))
sources.append(put('WebRTCDataChannelTransport.kt','''package com.andysagent.ragent.core.p2p
import android.app.Application
// Deterministic RTC boundary. All controller, supervisor, lease and transport logic is real.
class WebRTCDataChannelTransport(candidate: P2PCandidate, application: Application): P2PSession {
 companion object { val connections = java.util.concurrent.atomic.AtomicInteger() }
 private var open=false
 override val isOpen get()=open
 override suspend fun connect():Result<Unit> { connections.incrementAndGet(); open=true; return Result.success(Unit) }
 override suspend fun request(request:P2PHttpRequest):Result<P2PHttpResponse> =
   Result.success(P2PHttpResponse(id=request.id, status=200, bodyBase64="e30="))
 override fun close() {open=false}
}
'''))
app=(root/'android/app/src/main/java/com/andysagent/ragent/RagentApplication.kt').read_text(encoding='utf-8')
# Exact existing top-level helpers; no copied recovery policy.
helpers=app[app.index('internal fun bootstrapRetryDelayMs'):]
helpers=helpers[:helpers.index('}.getOrDefault(0L)')+len('}.getOrDefault(0L)')]
sources.append(put('AppHelpers.kt','package com.andysagent.ragent\nimport java.time.Instant\ninternal const val BOOTSTRAP_RETRY_BASE_MS=1_000L\ninternal const val BOOTSTRAP_RETRY_MAX_MS=30_000L\n'+helpers))
controller=root/'android/app/src/main/java/com/andysagent/ragent/BoundTargetConnection.kt'
controllerBytes=controller.read_bytes()
sources.append(put('BoundTargetConnection.kt',controllerBytes.decode('utf-8')))
testroot=root/'android/app/src/androidTest/java/com/andysagent/ragent/BoundTargetConnectionTest.kt'
testBytes=testroot.read_bytes()
frozenSourceHashes={str(controller):hashlib.sha256(controllerBytes).hexdigest(),str(testroot):hashlib.sha256(testBytes).hexdigest()}
tests=testBytes.decode('utf-8').replace('\r\n','\n').replace('import androidx.test.core.app.ApplicationProvider\n','').replace('import androidx.test.ext.junit.runners.AndroidJUnit4\n','').replace('import org.junit.runner.RunWith\n','').replace('@RunWith(AndroidJUnit4::class)\n','').replace('ApplicationProvider.getApplicationContext<Application>()','Application()')
sources.append(put('BoundTargetConnectionTest.kt',tests))
extra=base/'EndpointlessSuccessAndMonitorTest.kt'
if extra.exists(): sources.append(put(extra.name,extra.read_text(encoding='utf-8')))
libs=cp['libraries']
for group in ['junit/junit/4.13.2','org.hamcrest/hamcrest-core/1.3']:
 found=list((pathlib.Path(os.environ.get('GRADLE_USER_HOME',str(pathlib.Path.home()/'.gradle')))/'caches/modules-2/files-2.1'/group).rglob('*.jar'))
 assert len(found)==1,(group,found)
 libs+=list(map(str,found))
java=str(pathlib.Path(os.environ['JAVA_HOME'])/'bin'/('java.exe' if os.name=='nt' else 'java'))
compiler=['-Xmx1536m','-cp',os.pathsep.join(cp['compilerClasspath']),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',os.pathsep.join(libs),'-d',str(stage/'classes')]+list(map(str,sources))
def run(name,args):
 with (stage/name).open('w',encoding='utf-8') as f:
  try:
   code=subprocess.run([java]+args,stdout=f,stderr=subprocess.STDOUT,encoding='utf-8',timeout=180).returncode
  except subprocess.TimeoutExpired:
   code=124; f.write('\nFixture subprocess exceeded its 180 second bound; terminated.\n')
 print(name,'exit',code,flush=True)
 print((stage/name).read_text(encoding='utf-8')[-9000:],flush=True)
 return code
code=run('compile.log',compiler)
if code==0:
 runtime=[p for p in libs if not p.endswith('android.jar') and 'core-for-system-modules' not in p]
 classes=['com.andysagent.ragent.BoundTargetConnectionTest']
 if extra.exists(): classes.append('com.andysagent.ragent.EndpointlessSuccessAndMonitorTest')
 code=run('tests.log',['-Xmx1536m','-cp',os.pathsep.join([str(stage/'classes')]+runtime),'org.junit.runner.JUnitCore']+classes)
manifest={'scope':'Actual BoundTargetConnection source and existing Android test bodies with runner/application accessor substitution. Actual cached ConnectivitySupervisor, OkHttp transport and lease. Android Application/NetworkMonitor and WebRTC boundary substituted. No phone/network/service proof.','sourceRoot':str(root),'sourceHashes':frozenSourceHashes,'fixtureHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},'terminalExit':code,'runtimeLibraries':libs}
(stage/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
sys.exit(code)
