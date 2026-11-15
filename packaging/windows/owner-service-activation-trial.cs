// Retained administrative service lease. The transaction coordinator separately
// owns trust admission, metadata commit and health/quarantine. No arbitrary argv.
using System;using System.Runtime.InteropServices;using System.Diagnostics;using System.Threading;using System.Security.Principal;
public sealed class OwnerServiceActivationTrial:IDisposable {
 [StructLayout(LayoutKind.Sequential)]struct Config{public uint type,start,error;public IntPtr command,group;public uint tag;public IntPtr dependencies,account,display;}
 [StructLayout(LayoutKind.Sequential)]struct Status{public uint type,state,controls,win32,service,checkpoint,hint,pid,flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string a,string b,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig(IntPtr service,IntPtr config,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool QueryServiceStatusEx(IntPtr service,int kind,out Status status,int size,out int needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig2(IntPtr service,uint kind,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool DeleteService(IntPtr service);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ChangeServiceConfig(IntPtr service,uint type,uint start,uint error,string command,string group,IntPtr tag,string dependencies,string account,string password,string display);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool StartService(IntPtr service,int count,IntPtr args);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool ControlService(IntPtr service,uint control,out Status status);
 [DllImport("advapi32.dll")]static extern bool CloseServiceHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr process,uint ms);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 readonly string command,account,dependency;IntPtr handle,process;uint mode=4,pid;bool changed,startIssued,startAttempted;
 readonly bool removal,mutating;bool drained;
 public string Name{get;private set;}
 public uint ProcessId{get{return pid;}}public uint LastServiceState{get;private set;}public uint LastServiceError{get;private set;}public uint LastSpecificServiceError{get;private set;}public uint LastServiceProcessId{get;private set;}public int LastStartError{get;private set;}public int LastProcessPinError{get;private set;}
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 public OwnerServiceActivationTrial(string name,string expectedCommand):this(name,expectedCommand,false,true){}
 public static OwnerServiceActivationTrial OpenForRemoval(string name,string expectedCommand){return new OwnerServiceActivationTrial(name,expectedCommand,true,true);}
 public static OwnerServiceActivationTrial OpenForRemovalCheck(string name,string expectedCommand){return new OwnerServiceActivationTrial(name,expectedCommand,true,false);}
 OwnerServiceActivationTrial(string name,string expectedCommand,bool removing,bool canMutate){
  Need(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),"OAT_ADMIN_REQUIRED");
  Need(name=="Ragent-ControlPlane"||name=="Ragent-RunnerSupervisor","OAT_SERVICE_NAME_REFUSED");Need(!String.IsNullOrEmpty(expectedCommand),"OAT_COMMAND_REQUIRED");
  removal=removing;mutating=canMutate;Name=name;command=expectedCommand;account=@"NT SERVICE\"+name;dependency=name=="Ragent-ControlPlane"?"Ragent-RunnerSupervisor":"";
  var manager=OpenSCManager(null,null,1);Need(manager!=IntPtr.Zero,"OAT_SCM_OPEN_REFUSED");try{handle=OpenService(manager,name,removing?(canMutate?0x10027u:5u):0x37u);}finally{CloseServiceHandle(manager);}Need(handle!=IntPtr.Zero,"OAT_SERVICE_OPEN_REFUSED");
  try{VerifyConfig(removing);var state=State();if(removing){Need(state.state==1||state.state==4,"OAT_REMOVAL_STATE_REFUSED");if(state.state==4){Pin(state);startIssued=startAttempted=true;}changed=canMutate;}else Need(state.state==1,"OAT_STOPPED_REQUIRED");}catch{Dispose();throw;}
 }
 Status State(){Status s;int n;Need(QueryServiceStatusEx(handle,0,out s,Marshal.SizeOf(typeof(Status)),out n),"OAT_STATUS_REFUSED");LastServiceState=s.state;LastServiceError=s.win32;LastSpecificServiceError=s.service;LastServiceProcessId=s.pid;Need(s.type==16,"OAT_SERVICE_TYPE_CHANGED");if(s.state==1)Need(s.pid==0,"OAT_DRAIN_UNCONFIRMED");return s;}
 void VerifyConfig(bool captureMode=false){
  uint n;QueryServiceConfig(handle,IntPtr.Zero,0,out n);Need(n>0&&n<=65536,"OAT_CONFIG_REFUSED");var memory=Marshal.AllocHGlobal((int)n);
  try{Need(QueryServiceConfig(handle,memory,n,out n),"OAT_CONFIG_REFUSED");var c=(Config)Marshal.PtrToStructure(memory,typeof(Config));var dep=c.dependencies==IntPtr.Zero?"":Marshal.PtrToStringUni(c.dependencies);
   if(captureMode){Need(c.start==2||c.start==4,"OAT_REMOVAL_MODE_REFUSED");mode=c.start;}
   Need(c.type==16&&c.start==mode&&Marshal.PtrToStringUni(c.command)==command&&String.Equals(Marshal.PtrToStringUni(c.account),account,StringComparison.OrdinalIgnoreCase)&&dep==dependency,"OAT_CONFIG_CHANGED");
   if(dep.Length>0)Need(Marshal.ReadInt16(c.dependencies,(dep.Length+1)*2)==0,"OAT_DEPENDENCIES_CHANGED");
  }finally{Marshal.FreeHGlobal(memory);}
  if(removal){QueryServiceConfig2(handle,6,IntPtr.Zero,0,out n);Need(n>=IntPtr.Size&&n<=65536,"OAT_PRIVILEGES_REFUSED");memory=Marshal.AllocHGlobal((int)n);try{Need(QueryServiceConfig2(handle,6,memory,n,out n),"OAT_PRIVILEGES_REFUSED");var text=Marshal.ReadIntPtr(memory);string value=text==IntPtr.Zero?"":Marshal.PtrToStringUni(text);Need(value=="SeChangeNotifyPrivilege"&&Marshal.ReadInt16(text,(value.Length+1)*2)==0,"OAT_PRIVILEGES_CHANGED");}finally{Marshal.FreeHGlobal(memory);}}
 }
 void Configure(uint next){Need(ChangeServiceConfig(handle,0xffffffff,next,0xffffffff,null,null,IntPtr.Zero,null,null,null,null),"OAT_START_MODE_FAILED");mode=next;VerifyConfig();}
 void Pin(Status status){
  // SCM supplies the PID; SYNCHRONIZE is enough to retain and wait on that
  // exact process object. Avoid QUERY_LIMITED_INFORMATION, which virtual
  // service account process DACLs may refuse to LocalSystem callers.
  if(status.pid==0){LastProcessPinError=-1;throw new InvalidOperationException("OAT_PROCESS_PIN_REFUSED");}if(process==IntPtr.Zero){var owned=OpenProcess(0x00100000,false,status.pid);if(owned==IntPtr.Zero){LastProcessPinError=Marshal.GetLastWin32Error();throw new InvalidOperationException("OAT_PROCESS_PIN_REFUSED");}process=owned;pid=status.pid;}
  Need(status.pid==pid&&WaitForSingleObject(process,0)==258,"OAT_PROCESS_CHANGED");
  var current=State();Need(current.state==4&&current.pid==pid&&WaitForSingleObject(process,0)==258,"OAT_PROCESS_CHANGED");
 }
 public void Prepare(){VerifyConfig();Need(!removal&&!changed&&mode==4&&State().state==1,"OAT_STOPPED_REQUIRED");changed=true;Configure(3);}
 public void PrepareAutomatic(){VerifyConfig();Need(!removal&&!changed&&mode==4&&State().state==1,"OAT_STOPPED_REQUIRED");changed=true;Configure(2);}
 public void VerifyAutomaticStopped(){VerifyConfig();Need(changed&&mode==2&&!startAttempted&&State().state==1,"OAT_AUTOMATIC_STOPPED_REQUIRED");}
 public void VerifyRunning(){VerifyConfig();Need(startIssued&&process!=IntPtr.Zero,"OAT_RUNNING_REQUIRED");var s=State();Need(s.state==4,"OAT_RUNNING_REQUIRED");Pin(s);}
 public void Start(){
  VerifyConfig();Need(!removal&&changed&&(mode==3||mode==2)&&!startIssued&&State().state==1,"OAT_START_STATE_REFUSED");
  startAttempted=true;if(!StartService(handle,0,IntPtr.Zero)){LastStartError=Marshal.GetLastWin32Error();throw new InvalidOperationException("OAT_START_REFUSED");}startIssued=true;
  var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<30000){VerifyConfig();var s=State();if(s.state==1)throw new InvalidOperationException("OAT_STOPPED_BEFORE_RUNNING");if(s.state==4){Pin(s);Need(process!=IntPtr.Zero,"OAT_PROCESS_PIN_REFUSED");return;}Need(s.state==2,"OAT_UNEXPECTED_START_STATE");Thread.Sleep(100);}throw new InvalidOperationException("OAT_START_TIMEOUT");
 }
 public void RestoreDisabled(){
  Need(mutating,"OAT_READ_ONLY_LEASE");
  if(!changed)return;VerifyConfig();var s=State();Need(!startAttempted||process!=IntPtr.Zero,"OAT_PROCESS_DRAIN_UNCONFIRMED");
  if(s.state!=1){Need(startIssued&&process!=IntPtr.Zero&&s.state==4,"OAT_UNKNOWN_RUNNING_PROCESS");Pin(s);Status after;Need(ControlService(handle,1,out after),"OAT_STOP_REFUSED");var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<(removal?60000:15000)){VerifyConfig();s=State();if(s.state==1)break;Need(s.state==3,"OAT_UNEXPECTED_STOP_STATE");Thread.Sleep(100);}Need(s.state==1,"OAT_STOP_TIMEOUT");}
  if(process!=IntPtr.Zero)Need(WaitForSingleObject(process,15000)==0,"OAT_PROCESS_DRAIN_TIMEOUT");
  VerifyConfig();Need(State().state==1,"OAT_DRAIN_UNCONFIRMED");Configure(4);Need(State().state==1,"OAT_RESTORE_STATE_CHANGED");changed=false;drained=true;
 }
 // Retain the validated SCM and process handles while stopping an active
 // service. Leave its automatic start mode intact so a system restart after
 // an interrupted MSI transaction can still recover the installation.
 public void QuiesceForRemoval(){
  Need(removal&&mutating&&changed&&mode==2,"OAT_QUIESCE_STATE_REFUSED");VerifyConfig();var s=State();
  Need(s.state==4&&startIssued&&process!=IntPtr.Zero,"OAT_QUIESCE_STATE_REFUSED");Pin(s);
  Status after;Need(ControlService(handle,1,out after),"OAT_STOP_REFUSED");var clock=Stopwatch.StartNew();
  while(clock.ElapsedMilliseconds<60000){VerifyConfig();s=State();if(s.state==1)break;Need(s.state==3,"OAT_UNEXPECTED_STOP_STATE");Thread.Sleep(100);}
  Need(s.state==1&&WaitForSingleObject(process,15000)==0,"OAT_PROCESS_DRAIN_TIMEOUT");VerifyConfig();Need(State().state==1,"OAT_DRAIN_UNCONFIRMED");
 }
 public void VerifyRemoval(){Need(removal,"OAT_REMOVAL_LEASE_REQUIRED");VerifyConfig();var s=State();if(s.state==4){Need(process!=IntPtr.Zero,"OAT_UNKNOWN_RUNNING_PROCESS");Pin(s);}else{Need(s.state==1,"OAT_REMOVAL_STATE_REFUSED");if(process!=IntPtr.Zero)Need(WaitForSingleObject(process,0)==0,"OAT_PROCESS_DRAIN_UNCONFIRMED");}}
 public void RemoveDrained(){Need(removal&&mutating&&drained&&!changed&&mode==4,"OAT_REMOVAL_DRAIN_REQUIRED");VerifyRemoval();Need(State().state==1,"OAT_DRAIN_UNCONFIRMED");Need(DeleteService(handle),"OAT_DELETE_REFUSED");}
 // Disposal only releases retained handles. It cannot silently repair/stop an
 // uncertain registration; callers must restore explicitly and keep quarantine
 // if restoration fails. There is no forced process kill or Auto-start commit.
 public void Dispose(){if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}if(handle!=IntPtr.Zero){CloseServiceHandle(handle);handle=IntPtr.Zero;}}
}
