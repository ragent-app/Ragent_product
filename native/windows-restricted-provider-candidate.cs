// Candidate-only bounded Provider worker. Not connected to product Run admission.
// Fixed internal binaries, private marked root, fresh AppContainer per Run.
// internetClient permits public outbound, NOT endpoint-restricted egress.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

static class RestrictedProviderWorker {
  static Dictionary<string,object> Spec;
  static long Deadline;
  static System.Diagnostics.Stopwatch Lifetime;
  static long LifetimeLimit;
  static bool cancelled;
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr sid; public uint attributes; }
  const uint Suspended = 4, UnicodeEnvironment = 0x400, ExtendedStartup = 0x80000, NoWindow = 0x08000000;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2;
    public IntPtr reservedPointer, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo basic; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr sid,capabilities; public uint count,reserved; }
  [StructLayout(LayoutKind.Sequential)] struct JobBasic {
    public long processTime,jobTime; public uint flags; public UIntPtr minimum,maximum;
    public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct JobExtended {
    public JobBasic basic; public IoCounters io; public UIntPtr a,b,c,d;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileIdentity {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write;
    public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
    public string Key() { return volume.ToString("x8")+"-"+indexHigh.ToString("x8")+"-"+indexLow.ToString("x8"); }
  }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
  [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out int session);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfoEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SecurityAttributes security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref JobExtended information,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,int size,out uint returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FileIdentity identity);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder path,uint size,uint flags);

  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformationW(IntPtr obj,int kind,StringBuilder data,uint size,out uint needed);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenWindowStationW(string name,bool inherit,uint access);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr obj,ref uint kind,byte[] data,uint size,out uint needed);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetUserObjectSecurity(IntPtr obj,ref uint kind,byte[] data);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktopW(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  static string ServiceDesktop;
  sealed class PrivateServiceDesktop : IDisposable {
    IntPtr previousStation,previousDesktop,station,desktop;bool selected,changed;byte[] previousDacl;
    public readonly Dictionary<string,object> Facts=new Dictionary<string,object>();
    static string Name(IntPtr obj){var name=new StringBuilder(512);uint needed;Check(GetUserObjectInformationW(obj,2,name,1024,out needed),"User object name");return name.ToString();}
    static IntPtr Descriptor(string sddl){var sd=new RawSecurityDescriptor(sddl);byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);IntPtr ptr=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,ptr,bytes.Length);return ptr;}
    public PrivateServiceDesktop(string profile,SecurityIdentifier package){
      try{
        previousStation=GetProcessWindowStation();previousDesktop=GetThreadDesktop(GetCurrentThreadId());
        string inherited=Name(previousStation);Facts["inheritedStationName"]=inherited;
        if(!Regex.IsMatch(inherited,"^Service-0x[0-9a-f]+-[0-9a-f]+[$]$",RegexOptions.IgnoreCase))throw new InvalidOperationException("NONINTERACTIVE_SERVICE_STATION_REQUIRED");
        string caller=WindowsIdentity.GetCurrent().User.Value;
        // Only open the fixed, admin-created QA station for this case/round.
        // No change to SCM's inherited station or any interactive WinSta0.
        string stationName="Ragent-QA-"+(string)ServiceManifest["caseId"]+"-r"+Convert.ToInt32(ServiceManifest["ipcRound"]);
        station=OpenWindowStationW(stationName,false,0x6002b);Check(station!=IntPtr.Zero,"Open fixed QA private service station");
        uint kind=4,size;GetUserObjectSecurity(station,ref kind,null,0,out size);
        if(size==0||size>65536)throw new InvalidOperationException("PRIVATE_STATION_DACL_UNAVAILABLE");
        previousDacl=new byte[size];Check(GetUserObjectSecurity(station,ref kind,previousDacl,size,out size),"Read private station DACL");
        var descriptor=new RawSecurityDescriptor(previousDacl,0);if(descriptor.DiscretionaryAcl==null)throw new InvalidOperationException("PRIVATE_STATION_NULL_DACL");
        descriptor.DiscretionaryAcl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,0x20123,package,false,null));
        byte[] granted=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(granted,0);
        Check(SetUserObjectSecurity(station,ref kind,granted),"Grant fresh package in private station");changed=true;
        Check(SetProcessWindowStation(station),"Select private service station");selected=true;
        IntPtr sd=Descriptor("O:"+caller+"D:P(A;;GA;;;"+caller+")(A;;0x200c3;;;"+package.Value+")S:(ML;;NW;;;LW)");
        try{var attrs=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=sd,inherit=false};
          desktop=CreateDesktopW(profile,IntPtr.Zero,IntPtr.Zero,0,0xf01ff,ref attrs);Check(desktop!=IntPtr.Zero,"Create private service desktop");
        }finally{Marshal.FreeHGlobal(sd);}
        ServiceDesktop=Name(station)+"\\"+profile;
        Facts["fixedPreparedStation"]=true;Facts["privateDesktop"]=true;Facts["nonInteractiveSession0"]=true;
        Facts["exactPackageSid"]=package.Value;Facts["stationPackageMask"]=0x20123;Facts["desktopPackageMask"]=0x200c3;
        Facts["managementHandlesInherited"]=false;Facts["cleanupComplete"]=false;
      }catch{Dispose();throw;}
    }
    public void Dispose(){
      ServiceDesktop=null;bool ok=true;
      if(selected){ok=SetProcessWindowStation(previousStation)&&ok;ok=SetThreadDesktop(previousDesktop)&&ok;selected=false;}
      if(desktop!=IntPtr.Zero){ok=CloseDesktop(desktop)&&ok;desktop=IntPtr.Zero;}
      if(changed){uint kind=4;bool restored=SetUserObjectSecurity(station,ref kind,previousDacl);changed=false;
        uint size;GetUserObjectSecurity(station,ref kind,null,0,out size);byte[] actual=new byte[size];
        restored=restored&&GetUserObjectSecurity(station,ref kind,actual,size,out size)
          &&new RawSecurityDescriptor(actual,0).GetSddlForm(AccessControlSections.Access)==new RawSecurityDescriptor(previousDacl,0).GetSddlForm(AccessControlSections.Access);
        Facts["stationDaclRestored"]=restored;ok=restored&&ok;}
      if(station!=IntPtr.Zero){ok=CloseWindowStation(station)&&ok;station=IntPtr.Zero;}
      Facts["cleanupComplete"]=ok;
    }
  }
  static void Check(bool result,string operation) { if(!result) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static IntPtr TokenData(IntPtr token,int kind) {
    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    if(size<=0 || size>65536) throw new InvalidOperationException("Token evidence unavailable");
    IntPtr result=Marshal.AllocHGlobal(size);
    try { Check(GetTokenInformation(token,kind,result,size,out size),"GetTokenInformation"); return result; }
    catch { Marshal.FreeHGlobal(result); throw; }
  }
  static string Hash(string value) { using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant(); }
  static Dictionary<string,object> TokenFacts(IntPtr process) {
    IntPtr token; Check(OpenProcessToken(process,8,out token),"OpenProcessToken");
    try {
      string userSid,package=null; int integrity,elevated,app,capabilityCount;
      var capabilitySids=new List<string>();
      IntPtr data=TokenData(token,1);
      try { userSid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,25);
      try { string sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; integrity=int.Parse(sid.Substring(sid.LastIndexOf('-')+1)); } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,20); try { elevated=Marshal.ReadInt32(data); } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,29); try { app=Marshal.ReadInt32(data); } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,30); try {
        capabilityCount=Marshal.ReadInt32(data);
        if(capabilityCount<0 || capabilityCount>64) throw new InvalidOperationException("Invalid token capabilities");
        int offset=IntPtr.Size==8?8:4, stride=Marshal.SizeOf(typeof(SidAndAttributes));
        for(int i=0;i<capabilityCount;i++) capabilitySids.Add(new SecurityIdentifier(Marshal.ReadIntPtr(data,offset+i*stride)).Value);
      } finally { Marshal.FreeHGlobal(data); }
      if(app!=0) { data=TokenData(token,31); try { package=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally { Marshal.FreeHGlobal(data); } }
      int session;Check(ProcessIdToSessionId(GetProcessId(process),out session),"Process session");
      return new Dictionary<string,object>{{"sessionId",session},{"isAppContainer",app!=0},{"isRestricted",IsTokenRestricted(token)},
        {"integrityRid",integrity},{"isElevated",elevated!=0},{"isSystem",userSid=="S-1-5-18"},
        {"userSidHash",Hash(userSid)},{"packageSid",package},{"capabilityCount",capabilityCount},{"capabilitySids",capabilitySids}};
    } finally { CloseHandle(token); }
  }
  static void NoReparse(string path) {
    string cursor=Path.GetFullPath(path);
    while(!String.IsNullOrEmpty(cursor)) {
      if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("Reparse test root/runtime rejected");
      string parent=Path.GetDirectoryName(cursor); if(parent==cursor) break; cursor=parent;
    }
  }
  static Dictionary<string,object> ServiceManifest;
  static void ProtectedQaObject(string path,bool directory) {
    NoReparse(path);
    FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
    string owner=((SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier))).Value;
    if(owner!="S-1-5-18"&&owner!="S-1-5-32-544")throw new InvalidOperationException("SERVICE_MANIFEST_OWNER_INVALID");
    if(directory&&!acl.AreAccessRulesProtected)throw new InvalidOperationException("SERVICE_ROOT_ACL_NOT_PROTECTED");
    FileSystemRights write=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
    foreach(FileSystemAccessRule ace in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
      string sid=ace.IdentityReference.Value;
      if(ace.AccessControlType==AccessControlType.Allow&&(ace.FileSystemRights&write)!=0&&sid!="S-1-5-18"&&sid!="S-1-5-32-544")
        throw new InvalidOperationException("SERVICE_MANIFEST_WRITABLE");
    }
  }
  static string VerifyRoot(string root,string profile,bool service) {
    root=Path.GetFullPath(root).TrimEnd('\\');
    string parent=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Ragent","restricted-runs")+"\\";
    bool allowed=root.StartsWith(parent,StringComparison.OrdinalIgnoreCase);
    if(service){
      var caller=WindowsIdentity.GetCurrent().User.Value;
      if(!caller.StartsWith("S-1-5-80-") || (int)TokenFacts(GetCurrentProcess())["sessionId"]!=0)throw new InvalidOperationException("SERVICE_EXECUTOR_REQUIRED");
      string runs=Path.GetDirectoryName(root),executor=Path.GetDirectoryName(runs),state=Path.GetDirectoryName(executor),qa=Path.GetDirectoryName(state);
      if(Path.GetFileName(runs)!="restricted-runs")throw new InvalidOperationException("SERVICE_ROOT_INVALID:runs");
      if(Path.GetFileName(executor)!="executor")throw new InvalidOperationException("SERVICE_ROOT_INVALID:executor");
      if(Path.GetFileName(state)!="state")throw new InvalidOperationException("SERVICE_ROOT_INVALID:state");
      if(!Regex.IsMatch(Path.GetFileName(qa),"^case-[a-f0-9]{32}$"))throw new InvalidOperationException("SERVICE_ROOT_INVALID:case");
      // This candidate uses the same fixed C: installation as Installed().
      // Shell folder lookup can be empty in the deliberately minimal service
      // child environment; it must not select or widen the trusted QA root.
      allowed=String.Equals(Path.GetDirectoryName(qa),@"C:\ProgramData\RagentIdentityQA",StringComparison.OrdinalIgnoreCase);
      if(!allowed)throw new InvalidOperationException("SERVICE_ROOT_INVALID:parent");
      if(!allowed)throw new InvalidOperationException("SERVICE_ROOT_INVALID");ProtectedQaObject(qa,true);
      ProtectedQaObject(Path.Combine(qa,"manifest.json"),false);ProtectedQaObject(Path.Combine(qa,".ragent-identity-qa"),false);
      var qaSpec=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(qa,"manifest.json")));
      if(!qaSpec.ContainsKey("crossServiceProvider")||!(bool)qaSpec["crossServiceProvider"]||(string)qaSpec["executorSid"]!=caller
        ||"case-"+(string)qaSpec["caseId"]!=Path.GetFileName(qa)
        ||File.ReadAllText(Path.Combine(qa,".ragent-identity-qa")).Trim()!=Path.GetFileName(qa))throw new InvalidOperationException("SERVICE_ROOT_BINDING_INVALID");
      ServiceManifest=qaSpec;
    }
    if(!allowed || !Regex.IsMatch(Path.GetFileName(root),"^[a-f0-9]{32}$")
        || !Regex.IsMatch(profile,"^ragent[.]restricted[.][a-f0-9]{32}$")) throw new InvalidOperationException("Not an owned probe root/profile");
    NoReparse(root);
    string marker=Path.Combine(root,".ragent-restricted-run"); NoReparse(marker);
    if(profile!="ragent.restricted."+Path.GetFileName(root) || File.ReadAllText(marker).Trim()!=profile) throw new InvalidOperationException("Probe marker mismatch");
    var owner=(SecurityIdentifier)Directory.GetAccessControl(root).GetOwner(typeof(SecurityIdentifier));
    if(owner.Value!=WindowsIdentity.GetCurrent().User.Value) throw new InvalidOperationException("Probe root owner mismatch");
    return root;
  }
  static void Grant(string path,SecurityIdentifier package,FileSystemRights rights) {
    NoReparse(path);
    var acl=Directory.GetAccessControl(path);
    acl.AddAccessRule(new FileSystemAccessRule(package,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    Directory.SetAccessControl(path,acl);
  }
  static string Quote(string value) {
    // Windows command-line quoting; all inputs here are fixed paths/arguments.
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='"') result.Append('\\',slashes*2+1); else result.Append('\\',slashes); result.Append(c); slashes=0; }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  static Dictionary<string,object> Launch(string root,IntPtr packageSid,string label,string program,string[] arguments) {
    if(File.Exists(Path.Combine(root,"control","cancel")) || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>=Deadline
      || Lifetime.ElapsedMilliseconds>=LifetimeLimit)
      return new Dictionary<string,object>{{"label",label},{"pass",false},{"cancelled",true},{"processCreated",false},{"remainingOwnedProcesses",0}};
    NoReparse(program);
    string runtime=Path.Combine(root,"runtime")+"\\";
    if(!Path.GetFullPath(program).StartsWith(runtime,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Probe executable outside runtime");
    IntPtr list=IntPtr.Zero,capsMemory=IntPtr.Zero,capSid=IntPtr.Zero,capArray=IntPtr.Zero,handlesMemory=IntPtr.Zero,environment=IntPtr.Zero,job=IntPtr.Zero,canaryHandle=IntPtr.Zero;
    var handles=new List<IntPtr>(); var descendants=new List<IntPtr>();
    ProcessInfo child=new ProcessInfo(); bool assigned=false,attributesReady=false;
    string stdout=Path.Combine(root,"evidence",label+".stdout"),stderr=Path.Combine(root,"evidence",label+".stderr");
    var report=new Dictionary<string,object>{{"label",label},{"pass",false}};
    try {
      var security=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),inherit=true};
      // Intentionally inheritable but excluded from HANDLE_LIST: prove that a
      // pre-opened control file cannot bypass the filesystem boundary.
      canaryHandle=CreateFileW(Path.Combine(root,"control","secret.txt"),0x80000000,1,ref security,3,0x80,IntPtr.Zero);
      Check(canaryHandle!=new IntPtr(-1),"Open synthetic canary handle");
      FileIdentity canaryIdentity; Check(GetFileInformationByHandle(canaryHandle,out canaryIdentity),"Canary file identity");
      IntPtr input=CreateFileW((label=="codex" || label=="claude")?Path.Combine(root,"control","prompt.txt"):"NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero); Check(input!=new IntPtr(-1),"stdin"); handles.Add(input);
      IntPtr output=CreateFileW(stdout,0x40000000,1,ref security,1,0x80,IntPtr.Zero); Check(output!=new IntPtr(-1),"stdout"); handles.Add(output);
      IntPtr error=CreateFileW(stderr,0x40000000,1,ref security,1,0x80,IntPtr.Zero); Check(error!=new IntPtr(-1),"stderr"); handles.Add(error);
      IntPtr length=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref length);
      list=Marshal.AllocHGlobal(length); Check(InitializeProcThreadAttributeList(list,2,0,ref length),"Initialize attributes"); attributesReady=true;
      var capabilitySid=new SecurityIdentifier("S-1-15-3-1");
      byte[] sidBytes=new byte[capabilitySid.BinaryLength]; capabilitySid.GetBinaryForm(sidBytes,0);
      capSid=Marshal.AllocHGlobal(sidBytes.Length); Marshal.Copy(sidBytes,0,capSid,sidBytes.Length);
      capArray=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
      Marshal.StructureToPtr(new SidAndAttributes{sid=capSid,attributes=4},capArray,false);
      var caps=new SecurityCapabilities{sid=packageSid,capabilities=capArray,count=1}; capsMemory=Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps,capsMemory,false);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),capsMemory,new IntPtr(Marshal.SizeOf(caps)),IntPtr.Zero,IntPtr.Zero),"AppContainer attribute");
      handlesMemory=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.Copy(handles.ToArray(),0,handlesMemory,3);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handlesMemory,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Handle allowlist");
      var startup=new StartupInfoEx{attributes=list}; startup.basic.cb=Marshal.SizeOf(typeof(StartupInfoEx)); startup.basic.flags=0x100;startup.basic.desktop=ServiceDesktop;
      startup.basic.stdin=input; startup.basic.stdout=output; startup.basic.stderr=error;
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows),work=Path.Combine(root,"workspace");
      string state=Path.Combine(root,"state");
      var vars=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
        {"RAGENT_PROBE_HANDLE",canaryHandle.ToInt64().ToString()},{"RAGENT_PROBE_HANDLE_ID",canaryIdentity.Key()},
        {"CODEX_HOME",state},{"HOME",state},{"USERPROFILE",state},{"LOCALAPPDATA",state},{"APPDATA",state},
        {"PATH",runtime.TrimEnd('\\')+";"+Path.Combine(windows,"System32")},{"PATHEXT",".EXE;.COM"},
        {"SystemRoot",windows},{"WINDIR",windows},{"TEMP",state},{"TMP",state},
        {"RUST_LOG","off"},{"NO_PROXY","*"}
      };
      if(label=="codex" || label=="claude") {
        string credentialPath=Path.Combine(root,"control","credential.json"); NoReparse(credentialPath);
        var credential=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(credentialPath));
        if(credential.Count!=1 || !credential.ContainsKey("apiKey") || !(credential["apiKey"] is string)
          || String.IsNullOrWhiteSpace((string)credential["apiKey"]) || ((string)credential["apiKey"]).IndexOf('\0')>=0)
          throw new InvalidOperationException("Invalid static credential envelope");
        if(label=="codex") vars["OPENAI_API_KEY"]=(string)credential["apiKey"];
        else {
          var config=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"runtime","provider.json")));
          vars["CLAUDE_CONFIG_DIR"]=state; vars["ANTHROPIC_API_KEY"]=(string)credential["apiKey"];
          vars["ANTHROPIC_BASE_URL"]=(string)config["baseUrl"]; vars["ANTHROPIC_MODEL"]=(string)config["model"];
          vars["ANTHROPIC_DEFAULT_HAIKU_MODEL"]=(string)config["model"]; vars["ANTHROPIC_DEFAULT_SONNET_MODEL"]=(string)config["model"];
          vars["ANTHROPIC_DEFAULT_OPUS_MODEL"]=(string)config["model"]; vars["ANTHROPIC_SMALL_FAST_MODEL"]=(string)config["model"];
          vars["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]="1"; vars["CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP"]="1";
          vars["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]="1"; vars["DISABLE_TELEMETRY"]="1";
        }
      }
      var envText=new StringBuilder(); foreach(var pair in vars)envText.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
      string env=envText.Append('\0').ToString();
      environment=Marshal.StringToHGlobalUni(env);
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"Create job");
      var limits=new JobExtended(); limits.basic.flags=0x2000|8; limits.basic.activeLimit=8;
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"Job limits");
      var command=new StringBuilder(Quote(program)); foreach(string arg in arguments) command.Append(" ").Append(Quote(arg));
      Check(CreateProcessW(program,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|UnicodeEnvironment|ExtendedStartup|NoWindow,environment,work,ref startup,out child),"Create AppContainer process");
      Check(AssignProcessToJobObject(job,child.process),"Assign suspended child job"); assigned=true;
      var token=TokenFacts(child.process); report["token"]=token; report["pid"]=child.pid;
      string expected=new SecurityIdentifier(packageSid).Value;
      if(!(bool)token["isAppContainer"] || (bool)token["isElevated"] || (int)token["integrityRid"]>4096 || ((List<string>)token["capabilitySids"]).Count!=1 || ((List<string>)token["capabilitySids"])[0]!="S-1-15-3-1" || (string)token["packageSid"]!=expected || (string)token["userSidHash"]!=Hash(WindowsIdentity.GetCurrent().User.Value)) throw new InvalidOperationException("Unexpected actual AppContainer token");
      Check(ResumeThread(child.thread)!=0xffffffff,"Resume child");
      bool timeout=false,overflow=false; cancelled=false;
      while(WaitForSingleObject(child.process,100)!=0) {
        if(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>=Deadline || Lifetime.ElapsedMilliseconds>=LifetimeLimit){timeout=true;break;}
        if(File.Exists(Path.Combine(root,"control","cancel"))){cancelled=true;break;}
        if(new FileInfo(stdout).Length>8*1024*1024 || new FileInfo(stderr).Length>2*1024*1024){overflow=true;break;}
      }
      report["cancelled"]=cancelled; report["outputOverflow"]=overflow;
      report["timedOut"]=timeout;
      uint code; Check(GetExitCodeProcess(child.process,out code),"Read exit code"); report["exitCode"]=code;
      // Retain handles while the job still owns each PID: no PID-reuse cleanup.
      IntPtr ids=Marshal.AllocHGlobal(8+IntPtr.Size*16);
      try {
        uint returned; Check(QueryInformationJobObject(job,3,ids,8+IntPtr.Size*16,out returned),"Query owned descendants");
        int count=Marshal.ReadInt32(ids,4); if(count<0 || count>8) throw new InvalidOperationException("Unexpected job membership");
        var descendantTokens=new List<Dictionary<string,object>>();
        for(int i=0;i<count;i++) {
          uint pid=(uint)Marshal.ReadIntPtr(ids,8+i*IntPtr.Size).ToInt64();
          if(pid==child.pid && !timeout) continue; // exited root may linger briefly in the job list
          IntPtr process=OpenProcess(0x101000,false,pid);
          if(process==IntPtr.Zero && Marshal.GetLastWin32Error()==87) continue; // already exited
          Check(process!=IntPtr.Zero,"Retain owned process");
          bool member; Check(IsProcessInJob(process,job,out member),"Recheck job ownership");
          if(!member || WaitForSingleObject(process,0)==0) { CloseHandle(process); continue; }
          descendants.Add(process);
          var descendantToken=TokenFacts(process); descendantToken["pid"]=pid; descendantTokens.Add(descendantToken);
          if(!(bool)descendantToken["isAppContainer"] || (string)descendantToken["packageSid"]!=expected) throw new InvalidOperationException("Descendant escaped AppContainer");
        }
        report["ownedProcessesAtCleanup"]=count;
        report["descendantTokens"]=descendantTokens;
      } finally { Marshal.FreeHGlobal(ids); }
      CloseHandle(job); job=IntPtr.Zero;
      int remaining=0; foreach(IntPtr process in descendants) if(WaitForSingleObject(process,5000)!=0) remaining++;
      report["remainingOwnedProcesses"]=remaining;
      report["pass"]=!timeout && !cancelled && !overflow && code==0 && remaining==0;
      return report;
    } catch(Exception error) {
      report["errorType"]=error.GetType().Name; report["error"]=error.Message;
      if(error is Win32Exception) report["nativeErrorCode"]=((Win32Exception)error).NativeErrorCode;
      return report;
    } finally {
      if(child.process!=IntPtr.Zero && !assigned) TerminateProcess(child.process,1);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(child.process!=IntPtr.Zero) { WaitForSingleObject(child.process,5000); CloseHandle(child.process); }
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      foreach(IntPtr handle in descendants) CloseHandle(handle);
      foreach(IntPtr handle in handles) CloseHandle(handle);
      if(canaryHandle!=IntPtr.Zero && canaryHandle!=new IntPtr(-1)) CloseHandle(canaryHandle);
      if(attributesReady) DeleteProcThreadAttributeList(list);
      foreach(IntPtr memory in new[]{list,capsMemory,capSid,capArray,handlesMemory,environment}) if(memory!=IntPtr.Zero) Marshal.FreeHGlobal(memory);
    }
  }
  static string Digest(string path) {
    NoReparse(path); using(var stream=File.OpenRead(path)) using(var sha=SHA256.Create())
      return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
  }
  static void ExactFile(string root,string relative,string expected) {
    if(!Regex.IsMatch(expected??"","^[a-f0-9]{64}$") || Digest(Path.Combine(root,relative))!=expected)
      throw new InvalidOperationException("Frozen input mismatch: "+relative);
  }
  static string Installed(string name) {
    if(name=="node.exe") {
      string root=Environment.GetEnvironmentVariable("RAGENT_INSTALL_ROOT");
      if(String.IsNullOrWhiteSpace(root))root=@"C:\Program Files\Ragent";
      return Path.Combine(root,"payload","node.exe");
    }
    if(name=="codex.exe") return "C:/ProgramData/Ragent/harnesses/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";
    if(name=="claude.exe") return "C:/ProgramData/Ragent/harnesses/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
    throw new InvalidOperationException("Unknown internal runtime");
  }
  public static int Main(string[] args) {
    if(args.Length==2 && args[0]=="path-facts") {
      var facts=new Dictionary<string,object>();
      var security=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),inherit=false};
      IntPtr file=CreateFileW(args[1],0,7,ref security,3,0x02000000,IntPtr.Zero);
      facts["openSucceeded"]=file!=new IntPtr(-1); facts["openError"]=file==new IntPtr(-1)?Marshal.GetLastWin32Error():0;
      try { if(file!=new IntPtr(-1)) foreach(uint flags in new uint[]{0,2,4}) {
        var buffer=new StringBuilder(4096); uint count=GetFinalPathNameByHandleW(file,buffer,4096,flags);
        facts["flags"+flags]=new{success=count>0,error=count==0?Marshal.GetLastWin32Error():0};
      } } finally {if(file!=new IntPtr(-1))CloseHandle(file);}
      Console.WriteLine(Json.Serialize(facts)); return 0;
    }
    string profile=null,root=null; IntPtr sid=IntPtr.Zero; bool created=false;PrivateServiceDesktop privateDesktop=null;
    var report=new Dictionary<string,object>{{"schemaVersion",1},{"pass",false},{"profileDeleted",false}};
    var locks=new List<FileStream>();
    try {
      bool service=args.Length==3&&(args[0]=="--service-run"||args[0]=="--service-boundary");
      bool boundaryOnly=service&&args[0]=="--service-boundary";
      if(args.Length!=2&&!service) throw new ArgumentException("Expected private candidate root and new profile");
      var host=TokenFacts(GetCurrentProcess()); report["hostToken"]=host;
      if((bool)host["isSystem"] || (bool)host["isElevated"] || (int)host["integrityRid"]>=12288 || (bool)host["isAppContainer"])
        throw new InvalidOperationException("Ordinary host required");
      profile=args[service?2:1]; root=VerifyRoot(args[service?1:0],profile,service);
      string specPath=Path.Combine(root,"control","launch.json"); NoReparse(specPath);
      Spec=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(specPath));
      var required=new List<string>{"version","caseId","runId","grantId","requestId","harness","authorityHash","expiresAtUnixMs","configSha256","inputSha256","promptSha256","probeSha256"};
      if(service)required.Add("providerSnapshotHash");string[] fields=required.ToArray();
      if(Spec.Count!=fields.Length || Array.Exists(fields,key=>!Spec.ContainsKey(key)) || Convert.ToInt32(Spec["version"])!=1
        || (string)Spec["caseId"]!=Path.GetFileName(root) || !Regex.IsMatch((string)Spec["runId"],"^run_(?:appapi_)?[a-f0-9]{32}$")
        || !Regex.IsMatch((string)Spec["grantId"],"^rtg_[A-Za-z0-9_-]{24,64}$")
        || !Regex.IsMatch((string)Spec["authorityHash"],"^[a-f0-9]{64}$")
        || !(Spec["requestId"] is string) || ((string)Spec["requestId"]).Length<1 || ((string)Spec["requestId"]).Length>200
        || Regex.IsMatch((string)Spec["requestId"],"[\\x00-\\x1f\\x7f]"))
        throw new InvalidOperationException("Invalid bound launch inputs");
      string harness=(string)Spec["harness"]; if(harness!="codex" && harness!="claude") throw new InvalidOperationException("Unsupported internal Harness");
      Deadline=Convert.ToInt64(Spec["expiresAtUnixMs"]);
      long now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      if(Deadline<=now || Deadline>now+180000) throw new InvalidOperationException("Invalid launch deadline");
      LifetimeLimit=Deadline-now; Lifetime=System.Diagnostics.Stopwatch.StartNew();
      if(File.Exists(Path.Combine(root,"control","cancel"))) throw new InvalidOperationException("Run cancelled before admission");
      foreach(string name in new[]{"node.exe",harness+".exe"}) {
        string copy=Path.Combine(root,"runtime",name);
        NoReparse(copy);
        locks.Add(new FileStream(copy,FileMode.Open,FileAccess.Read,FileShare.Read));
        string expected=service?(string)ServiceManifest[name]:Digest(Installed(name));
        if(!Regex.IsMatch(expected,"^[a-f0-9]{64}$")||Digest(copy)!=expected) throw new InvalidOperationException("Internal runtime copy mismatch");
      }
      report["runtimeVerification"]=service?"protected-admin-qa-manifest":"fixed-installed-runtime";
      ExactFile(root,"runtime\\provider.json",(string)Spec["configSha256"]);
      ExactFile(root,"runtime\\probe.mjs",(string)Spec["probeSha256"]);
      ExactFile(root,"workspace\\input.csv",(string)Spec["inputSha256"]);
      ExactFile(root,"control\\prompt.txt",(string)Spec["promptSha256"]);
      if(service){ExactFile(root,"control\\provider-binding.json",(string)Spec["providerSnapshotHash"]);report["providerSnapshotHash"]=Spec["providerSnapshotHash"];}
      foreach(string file in new[]{"runtime\\provider.json","runtime\\probe.mjs","control\\launch.json","control\\prompt.txt"})
        locks.Add(new FileStream(Path.Combine(root,file),FileMode.Open,FileAccess.Read,FileShare.Read));
      report["launchHash"]=Digest(specPath); report["runId"]=Spec["runId"]; report["grantId"]=Spec["grantId"]; report["requestId"]=Spec["requestId"]; report["authorityHash"]=Spec["authorityHash"];
      int hr=CreateAppContainerProfile(profile,"Ragent candidate restricted Provider","Private disposable candidate worker",IntPtr.Zero,0,out sid);
      if(hr!=0) Marshal.ThrowExceptionForHR(hr); created=true;
      var package=new SecurityIdentifier(sid); report["packageSid"]=package.Value;
      if(service){privateDesktop=new PrivateServiceDesktop(profile,package);report["serviceDesktop"]=privateDesktop.Facts;}
      Grant(Path.Combine(root,"runtime"),package,FileSystemRights.ReadAndExecute);
      Grant(Path.Combine(root,"workspace"),package,FileSystemRights.Modify);
      Grant(Path.Combine(root,"state"),package,FileSystemRights.Modify);
      var cases=new List<Dictionary<string,object>>(); report["cases"]=cases;
      cases.Add(Launch(root,sid,"boundary",Path.Combine(root,"runtime","node.exe"),new[]{"--preserve-symlinks-main","--preserve-symlinks",Path.Combine(root,"runtime","probe.mjs")}));
      if(!(bool)cases[0]["pass"]) throw new InvalidOperationException("Boundary probe failed before credential admission");
      var probe=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"evidence","boundary.stdout")));
      if(!probe.ContainsKey("pass") || !(bool)probe["pass"]) throw new InvalidOperationException("Boundary result invalid");
      if(boundaryOnly){report["boundaryOnly"]=true;report["pass"]=true;}
      else {
      var runtimeConfig=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"runtime","provider.json")));
      if(runtimeConfig.Count!=2 || !runtimeConfig.ContainsKey("model") || !runtimeConfig.ContainsKey("baseUrl"))
        throw new InvalidOperationException("Invalid static Provider snapshot");
      Uri endpoint;
      if(!(runtimeConfig["model"] is string) || !Regex.IsMatch((string)runtimeConfig["model"],"^[A-Za-z0-9._:/-]{1,128}$")
        || !(runtimeConfig["baseUrl"] is string) || !Uri.TryCreate((string)runtimeConfig["baseUrl"],UriKind.Absolute,out endpoint)
        || endpoint.Scheme!="https" || endpoint.UserInfo!="" || endpoint.Query!="" || endpoint.Fragment!="")
        throw new InvalidOperationException("Invalid static HTTPS Provider");
      if(harness=="codex") {
        string home=Path.Combine(root,"state");
        string config="model = "+Json.Serialize(runtimeConfig["model"])+"\nmodel_provider = \"restricted\"\n[model_providers.restricted]\nname = \"Candidate static provider\"\nbase_url = "+Json.Serialize(runtimeConfig["baseUrl"])+"\nwire_api = \"responses\"\nenv_key = \"OPENAI_API_KEY\"\n";
        File.WriteAllText(Path.Combine(home,"config.toml"),config,new UTF8Encoding(false));
        locks.Add(new FileStream(Path.Combine(home,"config.toml"),FileMode.Open,FileAccess.Read,FileShare.Read));
        cases.Add(Launch(root,sid,"codex",Path.Combine(root,"runtime","codex.exe"),new[]{"exec","--json","--ephemeral","--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox","-c","features.plugins=false","-c","project_doc_max_bytes=0","-c","model_reasoning_effort=\"low\"",
          "-C",Path.Combine(root,"workspace"),"-"}));
      } else {
        cases.Add(Launch(root,sid,"claude",Path.Combine(root,"runtime","claude.exe"),new[]{"-p","--model",(string)runtimeConfig["model"],
          "--output-format","stream-json","--verbose","--include-partial-messages","--no-session-persistence","--strict-mcp-config",
          "--mcp-config","{\"mcpServers\":{}}","--dangerously-skip-permissions","--tools","Read,Write,Edit","--allowed-tools","Read,Write,Edit",
          "--setting-sources","","--disable-slash-commands"}));
      }
      report["pass"]=cases.TrueForAll(item=>(bool)item["pass"]);
      }
    } catch(Exception error) { report["errorType"]=error.GetType().Name; report["error"]=error.Message;report["errorCode"]=error is Win32Exception?((Win32Exception)error).NativeErrorCode:0; }
    finally {
      if(privateDesktop!=null){try{privateDesktop.Dispose();if(!(bool)privateDesktop.Facts["cleanupComplete"])report["pass"]=false;}catch(Exception error){report["pass"]=false;report["desktopCleanupError"]=error.GetType().Name;}}
      if(created) { int hr=DeleteAppContainerProfile(profile); report["profileDeleteHresult"]=hr; report["profileDeleted"]=hr==0; if(hr!=0) report["pass"]=false; }
      if(sid!=IntPtr.Zero) FreeSid(sid);
      foreach(var stream in locks)stream.Dispose();
      string json=Json.Serialize(report); if(root!=null)File.WriteAllText(Path.Combine(root,"evidence","native-report.json"),json,new UTF8Encoding(false));
      Console.WriteLine(json);
    }
    return (bool)report["pass"]?0:1;
  }
}
