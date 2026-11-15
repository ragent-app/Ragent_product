// Diagnostic feasibility tool only. Not a shipped execution broker.
// Creates one new per-user AppContainer and touches ACLs only under a marked,
// current-user-owned test root. Never adopts an existing container/profile.
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

static class AppContainerProbe {
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
      IntPtr data=TokenData(token,1);
      try { userSid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,25);
      try { string sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; integrity=int.Parse(sid.Substring(sid.LastIndexOf('-')+1)); } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,20); try { elevated=Marshal.ReadInt32(data); } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,29); try { app=Marshal.ReadInt32(data); } finally { Marshal.FreeHGlobal(data); }
      data=TokenData(token,30); try { capabilityCount=Marshal.ReadInt32(data); } finally { Marshal.FreeHGlobal(data); }
      if(app!=0) { data=TokenData(token,31); try { package=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally { Marshal.FreeHGlobal(data); } }
      return new Dictionary<string,object>{{"isAppContainer",app!=0},{"isRestricted",IsTokenRestricted(token)},
        {"integrityRid",integrity},{"isElevated",elevated!=0},{"isSystem",userSid=="S-1-5-18"},
        {"userSidHash",Hash(userSid)},{"packageSid",package},{"capabilityCount",capabilityCount}};
    } finally { CloseHandle(token); }
  }
  static void NoReparse(string path) {
    string cursor=Path.GetFullPath(path);
    while(!String.IsNullOrEmpty(cursor)) {
      if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("Reparse test root/runtime rejected");
      string parent=Path.GetDirectoryName(cursor); if(parent==cursor) break; cursor=parent;
    }
  }
  static string VerifyRoot(string root,string profile) {
    root=Path.GetFullPath(root).TrimEnd('\\');
    string parent=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Ragent","isolation-probes")+"\\";
    if(!root.StartsWith(parent,StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(root),"^[a-f0-9]{32}$")
        || !Regex.IsMatch(profile,"^ragent[.]t2probe[.][a-f0-9]{32}$")) throw new InvalidOperationException("Not an owned probe root/profile");
    NoReparse(root);
    string marker=Path.Combine(root,".ragent-isolation-probe"); NoReparse(marker);
    if(File.ReadAllText(marker).Trim()!=profile) throw new InvalidOperationException("Probe marker mismatch");
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
    NoReparse(program);
    string runtime=Path.Combine(root,"runtime")+"\\";
    if(!Path.GetFullPath(program).StartsWith(runtime,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Probe executable outside runtime");
    IntPtr list=IntPtr.Zero,capsMemory=IntPtr.Zero,handlesMemory=IntPtr.Zero,environment=IntPtr.Zero,job=IntPtr.Zero,canaryHandle=IntPtr.Zero;
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
      IntPtr input=CreateFileW("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero); Check(input!=new IntPtr(-1),"stdin"); handles.Add(input);
      IntPtr output=CreateFileW(stdout,0x40000000,1,ref security,1,0x80,IntPtr.Zero); Check(output!=new IntPtr(-1),"stdout"); handles.Add(output);
      IntPtr error=CreateFileW(stderr,0x40000000,1,ref security,1,0x80,IntPtr.Zero); Check(error!=new IntPtr(-1),"stderr"); handles.Add(error);
      IntPtr length=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref length);
      list=Marshal.AllocHGlobal(length); Check(InitializeProcThreadAttributeList(list,2,0,ref length),"Initialize attributes"); attributesReady=true;
      var caps=new SecurityCapabilities{sid=packageSid}; capsMemory=Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps,capsMemory,false);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),capsMemory,new IntPtr(Marshal.SizeOf(caps)),IntPtr.Zero,IntPtr.Zero),"AppContainer attribute");
      handlesMemory=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.Copy(handles.ToArray(),0,handlesMemory,3);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handlesMemory,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Handle allowlist");
      var startup=new StartupInfoEx{attributes=list}; startup.basic.cb=Marshal.SizeOf(typeof(StartupInfoEx)); startup.basic.flags=0x100;
      startup.basic.stdin=input; startup.basic.stdout=output; startup.basic.stderr=error;
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows),work=Path.Combine(root,"workspace");
      string env="RAGENT_PROBE_HANDLE="+canaryHandle.ToInt64()+"\0RAGENT_PROBE_HANDLE_ID="+canaryIdentity.Key()+"\0HOME="+work+"\0LOCALAPPDATA="+work+"\0PATH="+runtime.TrimEnd('\\')+";"+Path.Combine(windows,"System32")+"\0PATHEXT=.EXE;.COM\0SystemRoot="+windows+"\0TEMP="+work+"\0TMP="+work+"\0USERPROFILE="+work+"\0WINDIR="+windows+"\0\0";
      environment=Marshal.StringToHGlobalUni(env);
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"Create job");
      var limits=new JobExtended(); limits.basic.flags=0x2000|8; limits.basic.activeLimit=8;
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"Job limits");
      var command=new StringBuilder(Quote(program)); foreach(string arg in arguments) command.Append(" ").Append(Quote(arg));
      Check(CreateProcessW(program,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|UnicodeEnvironment|ExtendedStartup|NoWindow,environment,work,ref startup,out child),"Create AppContainer process");
      Check(AssignProcessToJobObject(job,child.process),"Assign suspended child job"); assigned=true;
      var token=TokenFacts(child.process); report["token"]=token; report["pid"]=child.pid;
      string expected=new SecurityIdentifier(packageSid).Value;
      if(!(bool)token["isAppContainer"] || (bool)token["isElevated"] || (int)token["integrityRid"]>4096 || (int)token["capabilityCount"]!=0 || (string)token["packageSid"]!=expected) throw new InvalidOperationException("Unexpected actual AppContainer token");
      Check(ResumeThread(child.thread)!=0xffffffff,"Resume child");
      bool timeout=WaitForSingleObject(child.process,20000)!=0;
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
      report["pass"]=!timeout && code==0 && remaining==0;
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
      foreach(IntPtr memory in new[]{list,capsMemory,handlesMemory,environment}) if(memory!=IntPtr.Zero) Marshal.FreeHGlobal(memory);
    }
  }
  public static int Main(string[] args) {
    if(args.Length==3 && args[0]=="inspect-handle") {
      FileIdentity identity; Check(GetFileInformationByHandle(GetStdHandle(-11),out identity),"Positive inherited stdout handle");
      bool valid=false,leaked=false; int error=0; uint exceptionCode=0;
      try { valid=GetFileInformationByHandle(new IntPtr(long.Parse(args[1])),out identity); if(!valid)error=Marshal.GetLastWin32Error(); }
      catch(SEHException) {
        // Windows can raise STATUS_INVALID_HANDLE instead of returning error 6.
        // Classify only that exact status; other exceptions remain a failure.
        IntPtr pointers=Marshal.GetExceptionPointers();
        if(pointers!=IntPtr.Zero) exceptionCode=unchecked((uint)Marshal.ReadInt32(Marshal.ReadIntPtr(pointers)));
      }
      leaked=valid && identity.Key()==args[2];
      bool denied=valid?!leaked:(error==6 || exceptionCode==0xc0000008);
      Console.WriteLine(Json.Serialize(new{valid=valid,leaked=leaked,denied=denied,error=error,exceptionCode=exceptionCode})); return denied?0:1;
    }
    if(args.Length==1 && args[0]=="facts") { Console.WriteLine(Json.Serialize(TokenFacts(GetCurrentProcess()))); return 0; }
    if(args.Length==2 && args[0]=="derive" && Regex.IsMatch(args[1],"^ragent[.]t2probe[.][a-f0-9]{32}$")) {
      IntPtr derived; int hr=DeriveAppContainerSidFromAppContainerName(args[1],out derived);
      if(hr!=0) Marshal.ThrowExceptionForHR(hr);
      try { Console.WriteLine(new SecurityIdentifier(derived).Value); } finally { FreeSid(derived); }
      return 0;
    }
    string profile=null,root=null; IntPtr sid=IntPtr.Zero; bool created=false;
    var report=new Dictionary<string,object>{{"schemaVersion",1},{"pass",false},{"profileDeleted",false}};
    try {
      if(args.Length!=2) throw new ArgumentException("Expected owned test root and new profile name");
      var host=TokenFacts(GetCurrentProcess());
      if((bool)host["isSystem"] || (bool)host["isElevated"] || (int)host["integrityRid"]>=12288 || (bool)host["isAppContainer"]) throw new InvalidOperationException("Probe requires ordinary host user");
      profile=args[1]; root=VerifyRoot(args[0],profile); report["hostToken"]=host;
      int hr=CreateAppContainerProfile(profile,"Ragent isolation feasibility probe","Disposable synthetic test; no production credentials",IntPtr.Zero,0,out sid);
      if(hr!=0) Marshal.ThrowExceptionForHR(hr); created=true;
      var package=new SecurityIdentifier(sid); report["packageSid"]=package.Value;
      Grant(Path.Combine(root,"runtime"),package,FileSystemRights.ReadAndExecute);
      Grant(Path.Combine(root,"workspace"),package,FileSystemRights.Modify);
      var cases=new List<Dictionary<string,object>>(); report["cases"]=cases;
      // Node's default main-path canonicalization lstat()s C:\ itself, which
      // is outside this profile's ACL. Preserve module paths instead of
      // granting the container access to ancestor/user/control directories.
      cases.Add(Launch(root,sid,"node",Path.Combine(root,"runtime","node.exe"),new[]{"--preserve-symlinks-main","--preserve-symlinks",Path.Combine(root,"runtime","probe.mjs")}));
      cases.Add(Launch(root,sid,"codex",Path.Combine(root,"runtime","codex.exe"),new[]{"--version"}));
      report["cases"]=cases; report["pass"]=cases.TrueForAll(item=>(bool)item["pass"]);
    } catch(Exception error) { report["errorType"]=error.GetType().Name; report["error"]=error.Message; }
    finally {
      if(created) { int hr=DeleteAppContainerProfile(profile); report["profileDeleteHresult"]=hr; report["profileDeleted"]=hr==0; if(hr!=0) report["pass"]=false; }
      if(sid!=IntPtr.Zero) FreeSid(sid);
      string json=Json.Serialize(report); if(root!=null) File.WriteAllText(Path.Combine(root,"evidence","native-report.json"),json,new UTF8Encoding(false));
      Console.WriteLine(json);
    }
    return (bool)report["pass"] ? 0 : 1;
  }
}
