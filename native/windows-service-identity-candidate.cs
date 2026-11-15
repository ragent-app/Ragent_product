// Isolated identity/ACL canary, never the installed Ragent ServiceHost.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

sealed class IdentityCanary : ServiceBase {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=65536};
  string root,role; volatile bool stopping; NamedPipeServerStream ownerPipe;
  readonly ManualResetEvent desktopPreparationStopped=new ManualResetEvent(false);
  static Timer watchdog;
  [StructLayout(LayoutKind.Sequential)] struct ObjectSecurity {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStationW(string name,uint flags,uint access,ref ObjectSecurity security);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
  void PrepareDesktopObjects(Dictionary<string,object> spec){
    var report=new Dictionary<string,object>{{"pass",false},{"ready",false},{"stationClosed",false},{"tasksAccepted",0},{"processesLaunched",0}};IntPtr station=IntPtr.Zero,previousStation=GetProcessWindowStation();
    try{
      var token=Facts(GetCurrentProcess());Need((string)token["sid"]=="S-1-5-18"&&(int)token["sessionId"]==0,"PREPARER_SYSTEM_SESSION0_REQUIRED");
      Need((bool)spec["crossServiceProvider"],"PREPARER_PROVIDER_CASE_REQUIRED");int round=Convert.ToInt32(spec["ipcRound"]);Need(round==1||round==2,"PREPARER_ROUND_INVALID");
      string executor=(string)spec["executorSid"];Need(executor.StartsWith("S-1-5-80-"),"PREPARER_EXECUTOR_INVALID");
      string name="Ragent-QA-"+(string)spec["caseId"]+"-r"+round;
      var descriptor=new RawSecurityDescriptor("O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x6002b;;;"+executor+")S:(ML;;NW;;;LW)");
      byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);IntPtr memory=Marshal.AllocHGlobal(bytes.Length);
      try{Marshal.Copy(bytes,0,memory,bytes.Length);var attrs=new ObjectSecurity{length=Marshal.SizeOf(typeof(ObjectSecurity)),descriptor=memory,inherit=false};
        station=CreateWindowStationW(name,1,0xf037f,ref attrs);Check(station!=IntPtr.Zero,"PREPARER_CREATE_ONLY_STATION");
      }finally{Marshal.FreeHGlobal(memory);}
      report["stationName"]=name;report["executorSid"]=executor;report["executorMask"]=0x6002b;report["ready"]=true;
      Save(Path.Combine(root,"state","preparer","desktop-report.json"),report);
      while(!stopping)Thread.Sleep(50);
      report["pass"]=true;
    }catch(Exception error){report["error"]=error.Message;report["errorCode"]=error is Win32Exception?((Win32Exception)error).NativeErrorCode:0;}
    finally{if(station!=IntPtr.Zero){report["stationRestored"]=SetProcessWindowStation(previousStation);
        report["stationClosed"]=CloseWindowStation(station);if(!(bool)report["stationClosed"]){report["closeError"]=Marshal.GetLastWin32Error();report["pass"]=false;}
        if(!(bool)report["stationRestored"])report["pass"]=false;}
      try{Save(Path.Combine(root,"state","preparer","desktop-report.json"),report);}catch{}desktopPreparationStopped.Set();try{Stop();}catch{}}
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int cb;public string reserved,desktop,title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,reserved2;
    public IntPtr reservedPointer,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct Child {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct JobBasic {
    public long a,b;public uint flags;public UIntPtr minimum,maximum;public uint active;
    public UIntPtr affinity;public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {public ulong a,b,c,d,e,f;}
  [StructLayout(LayoutKind.Sequential)] struct JobLimits {public JobBasic basic;public Io io;public UIntPtr a,b,c,d;}
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes {public IntPtr sid;public uint attrs;}
  [StructLayout(LayoutKind.Sequential)] struct FileIdentity {
    public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write;
    public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenThreadToken(IntPtr thread,uint access,bool self,out IntPtr token);
  [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out int session);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr data,int size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disableAll,IntPtr state,int length,IntPtr previous,IntPtr returned);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeName(string system,IntPtr luid,StringBuilder name,ref int length);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out Child child);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref JobLimits info,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,int size,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,StringBuilder path,uint length,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileIdentity identity);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenSCManagerW(string machine,string database,uint access);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenServiceW(IntPtr manager,string name,uint access);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateServiceW(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,IntPtr password);
  [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
  static void Need(bool value,string code){if(!value)throw new InvalidOperationException(code);}
  static void Check(bool value,string code){if(!value)throw new Win32Exception(Marshal.GetLastWin32Error(),code);}
  static IntPtr Data(IntPtr token,int kind){
    int length;GetTokenInformation(token,kind,IntPtr.Zero,0,out length);Need(length>0&&length<=65536,"TOKEN_DATA_SIZE");
    var data=Marshal.AllocHGlobal(length);
    if(!GetTokenInformation(token,kind,data,length,out length)){Marshal.FreeHGlobal(data);throw new Win32Exception(Marshal.GetLastWin32Error());}
    return data;
  }
  static string PrivilegeName(IntPtr luid){int length=128;var name=new StringBuilder(length);Check(LookupPrivilegeName(null,luid,name,ref length),"PRIVILEGE_NAME");return name.ToString();}
  static Dictionary<string,object> Facts(IntPtr process){
    IntPtr token;Check(OpenProcessToken(process,8,out token),"TOKEN_QUERY");
    try{
      string sid;int integrity;bool elevated,admin=false;var privileges=new List<string>();
      IntPtr data=Data(token,1);try{sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;}finally{Marshal.FreeHGlobal(data);}
      data=Data(token,25);try{string label=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;integrity=int.Parse(label.Substring(label.LastIndexOf('-')+1));}finally{Marshal.FreeHGlobal(data);}
      data=Data(token,20);try{elevated=Marshal.ReadInt32(data)!=0;}finally{Marshal.FreeHGlobal(data);}
      data=Data(token,2);try{
        int count=Marshal.ReadInt32(data),offset=IntPtr.Size==8?8:4,stride=IntPtr.Size==8?16:8;Need(count>=0&&count<=1024,"TOKEN_GROUP_COUNT");
        for(int i=0;i<count;i++){var entry=IntPtr.Add(data,offset+i*stride);int attrs=Marshal.ReadInt32(entry,IntPtr.Size);
          if((attrs&4)!=0&&(attrs&16)==0&&new SecurityIdentifier(Marshal.ReadIntPtr(entry)).Value=="S-1-5-32-544")admin=true;}
      }finally{Marshal.FreeHGlobal(data);}
      data=Data(token,3);try{int count=Marshal.ReadInt32(data);Need(count>=0&&count<=256,"TOKEN_PRIVILEGE_COUNT");for(int i=0;i<count;i++)privileges.Add(PrivilegeName(IntPtr.Add(data,4+i*12)));}finally{Marshal.FreeHGlobal(data);}
      int session;Check(ProcessIdToSessionId(GetProcessId(process),out session),"PROCESS_SESSION_QUERY");
      return new Dictionary<string,object>{{"sid",sid},{"integrityRid",integrity},{"elevated",elevated},{"enabledAdministrators",admin},{"privileges",privileges},{"sessionId",session}};
    }finally{CloseHandle(token);}
  }
  static void Ordinary(Dictionary<string,object> facts,string sid){
    Need((string)facts["sid"]==sid&&!sid.Equals("S-1-5-18")&&!sid.Equals("S-1-5-19")&&!sid.Equals("S-1-5-20")
      &&!(bool)facts["elevated"]&&!(bool)facts["enabledAdministrators"]&&(int)facts["integrityRid"]==8192,"ORDINARY_TOKEN_REQUIRED");
    foreach(string privilege in (List<string>)facts["privileges"])Need(privilege=="SeChangeNotifyPrivilege","PRIVILEGE_REMAINED");
  }
  static void PermanentlyReduceOwnToken(){
    IntPtr threadToken;bool impersonating=OpenThreadToken(GetCurrentThread(),8,true,out threadToken);
    if(impersonating)CloseHandle(threadToken);Need(!impersonating&&Marshal.GetLastWin32Error()==1008,"UNEXPECTED_THREAD_TOKEN");
    IntPtr token;Check(OpenProcessToken(GetCurrentProcess(),8|32|128,out token),"TOKEN_REDUCE_OPEN");
    try{
      var before=Facts(GetCurrentProcess());string sid=(string)before["sid"];
      Need(!sid.Equals("S-1-5-18")&&!sid.Equals("S-1-5-19")&&!sid.Equals("S-1-5-20")&&!(bool)before["enabledAdministrators"],"UNSAFE_INITIAL_ACCOUNT");
      // Remove, not disable: the process and its children cannot reenable them.
      IntPtr data=Data(token,3);
      try{
        int count=Marshal.ReadInt32(data);var removals=new List<byte[]>();
        for(int i=0;i<count;i++){IntPtr luid=IntPtr.Add(data,4+i*12);if(PrivilegeName(luid)=="SeChangeNotifyPrivilege")continue;
          var entry=new byte[12];Marshal.Copy(luid,entry,0,8);Array.Copy(BitConverter.GetBytes(4),0,entry,8,4);removals.Add(entry);}
        if(removals.Count>0){IntPtr state=Marshal.AllocHGlobal(4+removals.Count*12);try{
          Marshal.WriteInt32(state,removals.Count);for(int i=0;i<removals.Count;i++)Marshal.Copy(removals[i],0,IntPtr.Add(state,4+i*12),12);
          Check(AdjustTokenPrivileges(token,false,state,0,IntPtr.Zero,IntPtr.Zero),"TOKEN_PRIVILEGES_REMOVE");
          Need(Marshal.GetLastWin32Error()!=1300,"TOKEN_PRIVILEGES_INCOMPLETE");
        }finally{Marshal.FreeHGlobal(state);}}
      }finally{Marshal.FreeHGlobal(data);}
      var medium=new SecurityIdentifier("S-1-16-8192");var bytes=new byte[medium.BinaryLength];medium.GetBinaryForm(bytes,0);
      IntPtr label=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAttributes))+bytes.Length);
      try{IntPtr labelSid=IntPtr.Add(label,Marshal.SizeOf(typeof(SidAttributes)));Marshal.Copy(bytes,0,labelSid,bytes.Length);Marshal.StructureToPtr(new SidAttributes{sid=labelSid,attrs=32},label,false);
        Check(SetTokenInformation(token,25,label,Marshal.SizeOf(typeof(SidAttributes))+bytes.Length),"TOKEN_INTEGRITY_REDUCE");
      }finally{Marshal.FreeHGlobal(label);}
      Ordinary(Facts(GetCurrentProcess()),sid);
    }finally{CloseHandle(token);}
  }
  static string Hash(string path){using(var stream=File.OpenRead(path))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
  static bool ServiceConfigDenied(string name){
    IntPtr manager=OpenSCManagerW(null,null,1);Check(manager!=IntPtr.Zero,"SCM_QUERY_OPEN");
    try{IntPtr service=OpenServiceW(manager,name,2);if(service!=IntPtr.Zero){CloseServiceHandle(service);return false;}
      Need(Marshal.GetLastWin32Error()==5,"SCM_DENIAL_UNRESOLVED");return true;
    }finally{CloseServiceHandle(manager);}
  }
  static object RegisterCanary(string root,string role){
    var caller=Facts(GetCurrentProcess());
    Need((bool)caller["enabledAdministrators"]&&(bool)caller["elevated"],"CANARY_ADMINISTRATOR_REQUIRED");
    Need(role=="control"||role=="executor"||role=="preparer","SERVICE_ROLE_INVALID");
    root=Path.GetFullPath(root);var spec=Spec(root,false);
    if(role=="preparer")Need(spec.ContainsKey("crossServiceProvider")&&(bool)spec["crossServiceProvider"],"PREPARER_PROVIDER_CASE_REQUIRED");
    string name="Ragent-IdentityQA-"+(role=="control"?"Control-":role=="executor"?"Executor-":"Preparer-")+(string)spec["caseId"];
    string binary=Path.Combine(root,"runtime","IdentityCanary.exe"),account=role=="preparer"?"LocalSystem":"NT SERVICE\\"+name;
    Need(String.Equals(Process.GetCurrentProcess().MainModule.FileName,binary,StringComparison.OrdinalIgnoreCase),"REGISTER_STAGED_BINARY_REQUIRED");
    IntPtr manager=OpenSCManagerW(null,null,2);Check(manager!=IntPtr.Zero,"SCM_CREATE_OPEN");
    try{
      // Virtual accounts require a NULL password pointer, not an empty string.
      // No arbitrary account, binary, start type or password is accepted.
      IntPtr service=CreateServiceW(manager,name,"Ragent isolated identity QA "+role,0,0x10,3,1,
        Quote(binary)+" "+Quote(root)+" "+role+" "+name,null,IntPtr.Zero,null,account,IntPtr.Zero);
      Check(service!=IntPtr.Zero,"VIRTUAL_SERVICE_CREATE");CloseServiceHandle(service);
      return new{pass=true,name=name,account=account,passwordNull=true,startType="Manual"};
    }finally{CloseServiceHandle(manager);}
  }
  static void NoReparse(string path){for(string p=Path.GetFullPath(path);!String.IsNullOrEmpty(p);p=Path.GetDirectoryName(p))Need((File.GetAttributes(p)&FileAttributes.ReparsePoint)==0,"REPARSE_REJECTED");}
  static Dictionary<string,object> Spec(string root,bool self){
    root=Path.GetFullPath(root).TrimEnd('\\');string id=Path.GetFileName(root);
    Need(Regex.IsMatch(id,"^case-[a-f0-9]{32}$"),"ROOT_ID_INVALID");
    string parent=self?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Ragent","identity-qa")
      :Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"RagentIdentityQA");
    Need(String.Equals(Path.GetDirectoryName(root),parent,StringComparison.OrdinalIgnoreCase),"ROOT_PREFIX_INVALID");NoReparse(root);
    Need(File.ReadAllText(Path.Combine(root,".ragent-identity-qa")).Trim()==id,"ROOT_MARKER_INVALID");
    var path=Path.Combine(root,"manifest.json");Need(new FileInfo(path).Length<16384,"MANIFEST_TOO_LARGE");
    var spec=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));Need((string)spec["caseId"]==id.Substring(5),"MANIFEST_ID_INVALID");
    foreach(var file in new[]{"node.exe","probe.mjs","IdentityCanary.exe"}){
      string target=Path.Combine(root,"runtime",file);NoReparse(target);Need(Hash(target)==(string)spec[file],"RUNTIME_HASH_MISMATCH");
    }
    if(spec.ContainsKey("crossServiceIpc")&&(bool)spec["crossServiceIpc"]){
      foreach(var file in new[]{"RunPipeCandidate.exe","chat/restricted-run-ipc.mjs","tests/helpers/windows-run-pipe-fixture.mjs","tests/fixtures/windows-service-run-ipc-probe.mjs"}){
        string target=Path.Combine(root,"runtime",file);NoReparse(target);Need(Hash(target)==(string)spec[file],"RUNTIME_HASH_MISMATCH");
      }
    }
    if(spec.ContainsKey("crossServiceProvider")&&(bool)spec["crossServiceProvider"]){
      Need(spec.ContainsKey("crossServiceIpc")&&(bool)spec["crossServiceIpc"],"PROVIDER_IPC_REQUIRED");
      foreach(var file in new[]{"RestrictedProviderCandidate.exe","claude.exe","tests/fixtures/windows-service-provider-worker.mjs","tests/fixtures/windows-service-provider-probe.mjs"}){
        string target=Path.Combine(root,"runtime",file);NoReparse(target);Need(Hash(target)==(string)spec[file],"RUNTIME_HASH_MISMATCH");
      }
    }
    if(spec.ContainsKey("ownerActivation")&&(bool)spec["ownerActivation"]){string activationRaw=Path.Combine(root,"runtime","OwnerActivationRaw.exe");NoReparse(activationRaw);Need(Hash(activationRaw)==(string)spec["OwnerActivationRaw.exe"],"RUNTIME_HASH_MISMATCH");}
    bool credential=spec.ContainsKey("crossServiceCredentialChannel")&&(bool)spec["crossServiceCredentialChannel"];
    if(credential||spec.ContainsKey("crossServiceOwnerBootstrap")&&(bool)spec["crossServiceOwnerBootstrap"]){
      foreach(string file in credential?new[]{"RunCredentialChannel.exe","owner-files.json"}:new[]{"OwnerBootstrap.exe","OwnerBootstrapRaw.exe","owner-files.json"}){
        string target=Path.Combine(root,"runtime",file);NoReparse(target);Need(Hash(target)==(string)spec[file],"RUNTIME_HASH_MISMATCH");}
      string indexPath=Path.Combine(root,"runtime","owner-files.json");Need(new FileInfo(indexPath).Length<=131072,"OWNER_INDEX_TOO_LARGE");
      var index=new JavaScriptSerializer{MaxJsonLength=131072,RecursionLimit=12}.Deserialize<OwnerIndex>(File.ReadAllText(indexPath));Need(index.version==1&&index.files!=null&&index.files.Count>0&&index.files.Count<=(credential?768:200),"OWNER_INDEX_INVALID");
      var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach(var row in index.files){Need(row.path!=null&&!row.path.Contains("..")&&paths.Add(row.path)
        &&(row.path=="package.json"||Regex.IsMatch(row.path,"^tests/fixtures/(?:windows-service-owner-bootstrap-probe|windows-service-owner-purpose-probe|windows-service-owner-set-probe|windows-service-owner-activation-probe|windows-service-credential-channel-probe|windows-service-provider-provision|local-control-authority)[.]mjs$")||Regex.IsMatch(row.path,"^chat/prompt-assets/(?:runtime|system|turn)/[a-zA-Z0-9_-]+[.](?:md|txt)$")||Regex.IsMatch(row.path,"^(?:lib|chat)/[a-zA-Z0-9_./-]+[.]mjs$")||credential&&Regex.IsMatch(row.path,"^node_modules/[a-zA-Z0-9_@./-]+[.](?:js|mjs|cjs|json)$")),"OWNER_INDEX_PATH_INVALID");
        string target=Path.Combine(root,"runtime",row.path.Replace('/','\\'));NoReparse(target);Need(Hash(target)==row.sha256,"RUNTIME_HASH_MISMATCH");}
    }
    return spec;
  }
  sealed class OwnerIndex {public int version;public List<OwnerSource> files;}
  sealed class OwnerSource {public string path;public string sha256;}
  static void Save(string path,object value){File.WriteAllText(path,Json.Serialize(value),new UTF8Encoding(false));}
  static string ReadBoundReport(string path){
    path=Path.GetFullPath(path);string roleDir=Path.GetDirectoryName(path),state=Path.GetDirectoryName(roleDir),root=Path.GetDirectoryName(state);
    Need(Path.GetFileName(state)=="state"&&((Path.GetFileName(roleDir)=="control"||Path.GetFileName(roleDir)=="executor")
      &&(Path.GetFileName(path)=="service-report.json"||Path.GetFileName(path)=="node-report.json")
      ||Path.GetFileName(roleDir)=="preparer"&&Path.GetFileName(path)=="desktop-report.json"),"REPORT_PATH_DENIED");
    string id=Path.GetFileName(root);
    Need(Regex.IsMatch(id,"^case-[a-f0-9]{32}$")&&String.Equals(Path.GetDirectoryName(root),
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"RagentIdentityQA"),StringComparison.OrdinalIgnoreCase),"REPORT_ROOT_DENIED");
    NoReparse(path);Need(File.ReadAllText(Path.Combine(root,".ragent-identity-qa")).Trim()==id,"REPORT_MARKER_INVALID");
    // Pin the file without write/delete sharing, then verify its actual target
    // before reading bytes. A service report must not become an elevated read
    // gadget through a junction or file-link replacement.
    using(var handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
      Need(!handle.IsInvalid,"REPORT_OPEN_FAILED");var final=new StringBuilder(32768);
      uint length=GetFinalPathNameByHandleW(handle,final,(uint)final.Capacity,0);
      Need(length>0&&length<final.Capacity&&String.Equals(final.ToString(),"\\\\?\\"+path,StringComparison.OrdinalIgnoreCase),"REPORT_TARGET_DENIED");
      FileIdentity identity;Check(GetFileInformationByHandle(handle,out identity),"REPORT_FILE_IDENTITY");
      Need(identity.links==1&&(identity.attributes&0x400)==0,"REPORT_LINK_DENIED");
      using(var stream=new FileStream(handle,FileAccess.Read)){
        Need(stream.Length>0&&stream.Length<=65536,"REPORT_SIZE_DENIED");
        using(var reader=new StreamReader(stream,new UTF8Encoding(false,true),false))return Json.Serialize(Json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd()));
      }
    }
  }
  static string Quote(string value){Need(!value.Contains("\"")&&!value.Contains("\r")&&!value.Contains("\n"),"PATH_QUOTE_INVALID");return "\""+value+"\"";}
  static Dictionary<string,object> RunNode(string root,string role,string sid,int timeout=25000){
    var result=new Dictionary<string,object>();Child child=new Child();IntPtr job=IntPtr.Zero,environment=IntPtr.Zero;bool assigned=false;
    try{
      string runtime=Path.Combine(root,"runtime"),work=Path.Combine(root,"workspace"),state=Path.Combine(root,"state",role);
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      string env="RAGENT_IDENTITY_QA_ROLE="+role+"\0RAGENT_IDENTITY_QA_ROOT="+root+"\0HOME="+state+"\0LOCALAPPDATA="+state+"\0PATH="+Path.Combine(windows,"System32")+"\0SystemRoot="+windows+"\0TEMP="+state+"\0TMP="+state+"\0USERPROFILE="+state+"\0WINDIR="+windows+"\0\0";
      environment=Marshal.StringToHGlobalUni(env);job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"JOB_CREATE");
      var limits=new JobLimits();limits.basic.flags=0x2000|8;limits.basic.active=8;Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"JOB_LIMITS");
      var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup))};string node=Path.Combine(runtime,"node.exe");
      Check(CreateProcessW(node,new StringBuilder(Quote(node)+" "+Quote(Path.Combine(runtime,"probe.mjs"))),IntPtr.Zero,IntPtr.Zero,false,4|0x400|0x08000000,environment,work,ref startup,out child),"NODE_CREATE_SUSPENDED");
      Check(AssignProcessToJobObject(job,child.process),"JOB_ASSIGN");assigned=true;
      var actual=Facts(child.process);Ordinary(actual,sid);result["childToken"]=actual;result["pid"]=child.pid;
      Check(ResumeThread(child.thread)!=0xffffffff,"NODE_RESUME");
      Need(WaitForSingleObject(child.process,(uint)timeout)==0,"NODE_TIMEOUT");uint code;Check(GetExitCodeProcess(child.process,out code),"NODE_EXIT_QUERY");result["exitCode"]=code;
      Check(TerminateJobObject(job,1),"JOB_STOP_DESCENDANTS");
      var data=Marshal.AllocHGlobal(8+8*IntPtr.Size);try{
        uint returned;int remaining=-1;for(int i=0;i<50;i++){
          Check(QueryInformationJobObject(job,3,data,8+8*IntPtr.Size,out returned),"JOB_QUERY");remaining=Marshal.ReadInt32(data,4);if(remaining==0)break;Thread.Sleep(20);
        }result["remainingProcesses"]=remaining;Need(remaining==0,"JOB_STOP_UNCONFIRMED");
      }finally{Marshal.FreeHGlobal(data);}
      Need(code==0,"NODE_PROBE_FAILED");result["pass"]=true;return result;
    }finally{
      if(child.process!=IntPtr.Zero&&!assigned)TerminateProcess(child.process,1);
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(child.process!=IntPtr.Zero){WaitForSingleObject(child.process,5000);CloseHandle(child.process);}
      if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
    }
  }
  IdentityCanary(string root,string role,string name){this.root=root;this.role=role;ServiceName=name;CanStop=true;AutoLog=false;}
  protected override void OnStart(string[] args){ThreadPool.QueueUserWorkItem(_=>Work());}
  protected override void OnStop(){stopping=true;try{if(ownerPipe!=null)ownerPipe.Dispose();}catch{}
    // ServiceBase.Run may return as soon as OnStop returns. Wait for this
    // fixed native worker's final close/report before allowing process exit.
    if(role=="preparer"&&!desktopPreparationStopped.WaitOne(10000))throw new InvalidOperationException("PREPARER_STOP_ACK_TIMEOUT");}
  void Work(){
    var report=new Dictionary<string,object>{{"role",role},{"pass",false}};

    try{
      var spec=Spec(root,false);string expected="Ragent-IdentityQA-"+(role=="control"?"Control-":role=="executor"?"Executor-":"Preparer-")+(string)spec["caseId"];
      Need(ServiceName==expected,"SERVICE_NAME_INVALID");if(role=="preparer"){PrepareDesktopObjects(spec);return;}string sid=(string)spec[role+"Sid"];
      int timeout=(spec.ContainsKey("crossServiceProvider")&&(bool)spec["crossServiceProvider"]||spec.ContainsKey("crossServiceOwnerBootstrap")&&(bool)spec["crossServiceOwnerBootstrap"]||spec.ContainsKey("crossServiceCredentialChannel")&&(bool)spec["crossServiceCredentialChannel"])?105000:25000;
      var before=Facts(GetCurrentProcess());Need((string)before["sid"]==sid&&sid.StartsWith("S-1-5-80-"),"VIRTUAL_ACCOUNT_REQUIRED");report["initialToken"]=before;
      PermanentlyReduceOwnToken();report["ordinaryToken"]=Facts(GetCurrentProcess());
      report["serviceConfigWriteDenied"]=ServiceConfigDenied(ServiceName);Need((bool)report["serviceConfigWriteDenied"],"SERVICE_CONFIG_WRITABLE");
      if(role=="control"){
        var acl=new PipeSecurity();acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid),PipeAccessRights.FullControl,AccessControlType.Allow));
        ownerPipe=new NamedPipeServerStream("ragent-identity-owner-"+(string)spec["caseId"],PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,acl,HandleInheritability.None);
        var wait=ownerPipe.BeginWaitForConnection(null,null);
        report["node"]=RunNode(root,role,sid,timeout);Need(wait.AsyncWaitHandle.WaitOne(5000),"OWNER_PIPE_POSITIVE_MISSING");ownerPipe.EndWaitForConnection(wait);ownerPipe.Disconnect();
        ownerPipe.BeginWaitForConnection(null,null);
        report["ownerPipeDacl"]=ownerPipe.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access);
      }else report["node"]=RunNode(root,role,sid,timeout);

      report["pass"]=true;Save(Path.Combine(root,"state",role,"service-report.json"),report);
      if(role=="control")while(!stopping)Thread.Sleep(50);
    }catch(Exception error){report["errorCode"]=error is Win32Exception?((Win32Exception)error).NativeErrorCode:0;report["errorType"]=error.GetType().Name;
      report["error"]=error.Message;try{Save(Path.Combine(root,"state",role,"service-report.json"),report);}catch{}}
    finally{try{if(ownerPipe!=null)ownerPipe.Dispose();}catch{}try{Stop();}catch{}}
  }
  public static int Main(string[] args){
    watchdog=new Timer(_=>Environment.Exit(2),null,120000,Timeout.Infinite);
    try{
      if(args.Length==3&&args[0]=="--register-canary"){Console.WriteLine(Json.Serialize(RegisterCanary(args[1],args[2])));return 0;}
      if(args.Length==2&&args[0]=="--read-report"){Console.WriteLine(ReadBoundReport(args[1]));return 0;}
      if(args.Length==2&&args[0]=="--self-test"){
        string root=Path.GetFullPath(args[1]);var spec=Spec(root,true);var before=Facts(GetCurrentProcess());
        Need(!(bool)before["elevated"]&&!(bool)before["enabledAdministrators"]&&(int)before["integrityRid"]==8192,"SELF_TEST_ORDINARY_REQUIRED");
        PermanentlyReduceOwnToken();var after=Facts(GetCurrentProcess());var child=RunNode(root,"selftest",(string)after["sid"]);
        Console.WriteLine(Json.Serialize(new{pass=true,before=before,after=after,node=child}));return 0;
      }
      Need(args.Length==3&&(args[1]=="control"||args[1]=="executor"||args[1]=="preparer"),"SERVICE_ARGUMENTS_INVALID");
      ServiceBase.Run(new IdentityCanary(Path.GetFullPath(args[0]),args[1],args[2]));return 0;
    }catch(Exception error){Console.WriteLine(Json.Serialize(new{pass=false,errorType=error.GetType().Name,error=error.Message,code=error is Win32Exception?((Win32Exception)error).NativeErrorCode:0}));return 1;}
    finally{watchdog.Dispose();}
  }
}
