// Dedicated one-Run credential channel. Private parent stdio; no shell/store/Owner API.
// Each endpoint has one private parent stdio channel and one pinned pipe peer.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

partial class WindowsRunCredentialChannel {
  const int Limit = 262144;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 24 };
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern SafePipeHandle CreateNamedPipe(string name, uint mode, uint pipeMode, uint instances,
    uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES security);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern SafePipeHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr handle,uint information,byte[] data,uint length,out uint needed);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle,uint information,byte[] data);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(int pid, out int session);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }

  static void Require(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
  static string Str(IDictionary<string, object> v, string key) { object raw; return v.TryGetValue(key, out raw) ? raw as string : null; }
  static long Num(IDictionary<string, object> v, string key) { return Convert.ToInt64(v[key]); }
  static Dictionary<string, object> Parse(string value) { return Json.Deserialize<Dictionary<string, object>>(value); }
  static void Emit(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  static string ParentLine() {
    var builder = new StringBuilder();
    for (;;) {
      int value = Console.In.Read();
      Require(value >= 0, "RCC_PARENT_DISCONNECTED");
      if (value == 10) break;
      Require(value != 13, "RCC_FRAME_INVALID");
      builder.Append((char)value); Require(builder.Length <= Limit, "RCC_FRAME_TOO_LARGE");
    }
    var line = builder.ToString(); Require(Utf8.GetByteCount(line) <= Limit, "RCC_FRAME_TOO_LARGE"); return line;
  }
  static byte[] ReadExact(Stream stream, int length) {
    var result = new byte[length]; int offset = 0;
    while (offset < length) { int count = stream.Read(result, offset, length-offset); Require(count > 0, "RCC_PEER_DISCONNECTED"); offset += count; }
    return result;
  }
  static string ReadFrame(Stream stream) {
    int length = BitConverter.ToInt32(ReadExact(stream, 4), 0);
    Require(length > 0 && length <= Limit, "RCC_FRAME_TOO_LARGE");
    return Utf8.GetString(ReadExact(stream, length));
  }
  static void WriteFrame(Stream stream, string value) {
    var bytes = Utf8.GetBytes(value); Require(bytes.Length > 0 && bytes.Length <= Limit, "RCC_FRAME_TOO_LARGE");
    var size = BitConverter.GetBytes(bytes.Length); stream.Write(size,0,4); stream.Write(bytes,0,bytes.Length); stream.Flush();
  }
  static IntPtr TokenData(IntPtr token,int kind) {
    int needed; GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);
    Require(needed>0 && needed<=65536,"RCC_TOKEN_UNAVAILABLE");
    IntPtr data=Marshal.AllocHGlobal(needed);
    if(!GetTokenInformation(token,kind,data,needed,out needed)){Marshal.FreeHGlobal(data);throw new InvalidOperationException("RCC_TOKEN_UNAVAILABLE");}
    return data;
  }
  static Dictionary<string, object> Facts(int pid, IntPtr process) {
    IntPtr token; Require(OpenProcessToken(process, 8, out token), "RCC_TOKEN_UNAVAILABLE");
    try {
      string userSid; int rid; bool admin=false,elevated;
      IntPtr data=TokenData(token,1);
      try { userSid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,25);
      try { IntPtr sid=Marshal.ReadIntPtr(data);rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(Marshal.ReadByte(GetSidSubAuthorityCount(sid))-1))); }
      finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,2);
      try {
        int count=Marshal.ReadInt32(data);Require(count>=0 && count<=1024,"RCC_TOKEN_UNAVAILABLE");
        int offset=IntPtr.Size==8?8:4, stride=IntPtr.Size==8?16:8;
        for(int i=0;i<count;i++){
          IntPtr entry=IntPtr.Add(data,offset+i*stride);
          int attrs=Marshal.ReadInt32(entry,IntPtr.Size);
          if((attrs&4)!=0 && (attrs&16)==0 && new SecurityIdentifier(Marshal.ReadIntPtr(entry)).Value=="S-1-5-32-544")admin=true;
        }
      } finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,20);try {elevated=Marshal.ReadInt32(data)!=0;} finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,29);try {Require(Marshal.ReadInt32(data)==0,"RCC_APPCONTAINER_DENIED");}finally {Marshal.FreeHGlobal(data);}
      Require(userSid!="S-1-5-18" && userSid!="S-1-5-19" && userSid!="S-1-5-20" && !admin && !elevated
        && rid>=8192 && rid<12288,"RCC_PEER_IDENTITY_UNSAFE");
      long created,exited,kernel,user;int session=-1;
      Require(GetProcessTimes(process,out created,out exited,out kernel,out user) && ProcessIdToSessionId(pid,out session),"RCC_PROCESS_UNAVAILABLE");
      return new Dictionary<string, object> { {"pid",pid}, {"createdTicks",created.ToString()},
        {"sid",userSid}, {"sessionId",session}, {"integrityRid",rid}, {"elevated",elevated}, {"enabledAdministrators",admin} };
    } finally { CloseHandle(token); }
  }
  sealed class ProcessPin:IDisposable {
    public IntPtr Handle;
    public ProcessPin(int pid){Handle=OpenProcess(0x1000,false,pid);Require(Handle!=IntPtr.Zero,"RCC_PROCESS_UNAVAILABLE");}
    public void Dispose(){if(Handle!=IntPtr.Zero){CloseHandle(Handle);Handle=IntPtr.Zero;}}
  }
  static void QueryAcl(IntPtr handle,string peerSid,int mask) {
    uint needed; GetKernelObjectSecurity(handle,4,null,0,out needed);
    Require(needed>0&&needed<=65536,"RCC_QUERY_ACL_SIZE");
    var bytes=new byte[needed];Require(GetKernelObjectSecurity(handle,4,bytes,needed,out needed),"RCC_QUERY_ACL_READ");
    var descriptor=new RawSecurityDescriptor(bytes,0);
    Require(descriptor.DiscretionaryAcl!=null,"RCC_QUERY_ACL_MISSING");
    descriptor.DiscretionaryAcl.InsertAce(descriptor.DiscretionaryAcl.Count,
      new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,mask,new SecurityIdentifier(peerSid),false,null));
    bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
    Require(SetKernelObjectSecurity(handle,4,bytes),"RCC_QUERY_ACL_WRITE");
  }
  static void PermitPeerQuery(string peer) {
    Require(System.Text.RegularExpressions.Regex.IsMatch(peer,"^S-1-5-(?:80|21)-(?:[0-9]+-){3,4}[0-9]+$"),"RCC_QUERY_POLICY_INVALID");
    IntPtr process=OpenProcess(0x60000,false,Process.GetCurrentProcess().Id);Require(process!=IntPtr.Zero,"RCC_SELF_DACL_UNAVAILABLE");
    try{QueryAcl(process,peer,0x1000);}finally{CloseHandle(process);}
    IntPtr token;Require(OpenProcessToken(Process.GetCurrentProcess().Handle,0x60008,out token),"RCC_SELF_TOKEN_DACL_UNAVAILABLE");
    try{QueryAcl(token,peer,8);}finally{CloseHandle(token);}
  }
  static void ProveQueryOnly(int pid,IntPtr process) {
    foreach(uint right in new uint[]{1,2,0x10,0x20,0x40,0x40000}){
      IntPtr other=OpenProcess(right,false,pid);if(other!=IntPtr.Zero){CloseHandle(other);throw new InvalidOperationException("RCC_PEER_PROCESS_AUTHORITY_EXCESS");}
      Require(Marshal.GetLastWin32Error()==5,"RCC_PEER_PROCESS_DENIAL_UNRESOLVED");
    }
    foreach(uint right in new uint[]{1,2,4,0x20,0x80}){
      IntPtr token;bool opened=OpenProcessToken(process,right,out token);
      if(opened){CloseHandle(token);throw new InvalidOperationException("RCC_PEER_TOKEN_AUTHORITY_EXCESS");}
      Require(Marshal.GetLastWin32Error()==5,"RCC_PEER_TOKEN_DENIAL_UNRESOLVED");
    }
  }
  static ProcessPin Pin(PipeStream pipe, bool server, IDictionary<string, object> expected, out Dictionary<string, object> facts) {
    int pid;
    bool found = server ? GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)
      : GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid);
    Require(found && pid == Num(expected,"pid"), "RCC_PEER_PID_MISMATCH");
    var process = new ProcessPin(pid);
    try {
      // Retain the opened Process HANDLE through the exchange, preventing a
      // recycled PID from being treated as the admitted endpoint.
      facts = Facts(pid,process.Handle);
      Require(Str(facts,"createdTicks") == Str(expected,"createdTicks")
        && Str(facts,"sid") == Str(expected,"sid")
        && Num(facts,"sessionId") == Num(expected,"sessionId"), "RCC_PEER_PIN_MISMATCH");
      if(Str(facts,"sid")!=WindowsIdentity.GetCurrent().User.Value){ProveQueryOnly(pid,process.Handle);facts["queryOnlyAuthorityVerified"]=true;}
      return process;
    } catch { process.Dispose(); throw; }
  }
  static NamedPipeServerStream Server(string name, string localSid, string peerSid) {
    // No Users/Everyone grant, no FILE_CREATE_PIPE_INSTANCE for the client.
    // Network logons are denied even if their user SID is otherwise allowed.
    string dacl = "D:P(D;;GA;;;NU)(A;;GA;;;"+localSid+")(A;;0x0012019b;;;"+peerSid+")";
    var security = new RawSecurityDescriptor(dacl); var bytes = new byte[security.BinaryLength]; security.GetBinaryForm(bytes,0);
    var memory = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes,0,memory,bytes.Length);
      var attributes = new SECURITY_ATTRIBUTES { length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), descriptor=memory, inherit=0 };
      // First instance + overlapped, byte mode + PIPE_REJECT_REMOTE_CLIENTS.
      var handle = CreateNamedPipe("\\\\.\\pipe\\"+name,0x40080003,8,1,Limit,Limit,0,ref attributes);
      if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
      try { return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle); }
      catch { handle.Dispose(); throw; }
    } finally { Marshal.FreeHGlobal(memory); }
  }
  static NamedPipeClientStream Client(string name) {
    // GENERIC_WRITE includes FILE_CREATE_PIPE_INSTANCE. Request only the exact
    // client mask in Server's DACL; SQOS_PRESENT + anonymous forbids impersonation.
    var handle=CreateFileW("\\\\.\\pipe\\"+name,0x0012019b,0,IntPtr.Zero,3,0x40100000,IntPtr.Zero);
    if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);}
    try{return new NamedPipeClientStream(PipeDirection.InOut,true,true,handle);}catch{handle.Dispose();throw;}
  }
  static string[] BindingFields={"instanceId","leaseId","runId","requestId","grantId","authorityHash"};
  static bool Match(string value,string pattern){return value!=null&&System.Text.RegularExpressions.Regex.IsMatch(value,pattern);}
  static void Keys(IDictionary<string,object> value,string[] keys){Require(value.Count==keys.Length,"RCC_FRAME_INVALID");foreach(string key in keys)Require(value.ContainsKey(key),"RCC_FRAME_INVALID");}
  static void Binding(IDictionary<string,object> binding){
    Keys(binding,new[]{"version","instanceId","leaseId","runId","requestId","grantId","authorityHash","expiresAtUnixMs"});
    Require(binding["version"] is int&&Num(binding,"version")==1&&binding["expiresAtUnixMs"] is long&&Match(Str(binding,"instanceId"),"^[^\\x00-\\x1f\\x7f]{1,128}$")
      &&Match(Str(binding,"leaseId"),"^[a-f0-9-]{36}$")&&Match(Str(binding,"runId"),"^run_[A-Za-z0-9_-]{8,128}$")
      &&Match(Str(binding,"requestId"),"^[^\\x00-\\x1f\\x7f]{1,200}$")&&Match(Str(binding,"grantId"),"^rtg_[A-Za-z0-9_-]{8,128}$")
      &&Match(Str(binding,"authorityHash"),"^[a-f0-9]{64}$"),"RCC_BINDING_INVALID");
    long remaining=Num(binding,"expiresAtUnixMs")-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();Require(remaining>0&&remaining<=120000,"RCC_EXPIRED");
  }
  static void CheckFrame(IDictionary<string,object> value,IDictionary<string,object> binding,string operation,string nonce,bool payload){
    Keys(value,payload?new[]{"version","operation","binding","nonce","payload"}:new[]{"version","operation","binding","nonce"});
    Require(value["version"] is int&&Num(value,"version")==1&&Str(value,"operation")==operation,"RCC_OPERATION_DENIED");
    var actual=(Dictionary<string,object>)value["binding"];Binding(actual);
    foreach(string field in BindingFields)Require(Str(actual,field)==Str(binding,field),"RCC_BINDING_MISMATCH");
    Require(Num(actual,"expiresAtUnixMs")==Num(binding,"expiresAtUnixMs"),"RCC_BINDING_MISMATCH");
    Require(Match(Str(value,"nonce"),"^[A-Za-z0-9_-]{43}$"),"RCC_NONCE_DENIED");
    if(nonce!=null){int delta=0;for(int i=0;i<43;i++)delta|=nonce[i]^Str(value,"nonce")[i];Require(delta==0,"RCC_NONCE_DENIED");}
    if(payload)Require(value["payload"] is Dictionary<string,object>,"RCC_FRAME_INVALID");
  }
  static Dictionary<string,object> Frame(IDictionary<string,object> binding,string operation,string nonce,object payload){
    var value=new Dictionary<string,object>{{"version",1},{"operation",operation},{"binding",binding},{"nonce",nonce}};
    if(payload!=null)value["payload"]=payload;return value;
  }
  public static int Main(string[] args){
    Console.InputEncoding=Utf8;Console.OutputEncoding=Utf8;
    var timer=new Timer(_=>Environment.Exit(2),null,10000,Timeout.Infinite);string stage="policy";
    try{
      Require(args.Length==1&&(args[0]=="server"||args[0]=="client"),"RCC_MODE_INVALID");bool server=args[0]=="server";
      var policy=Parse(ParentLine());Keys(policy,server?new[]{"pipeName","binding","controlSid","executorSid"}:new[]{"pipeName","binding","controlSid","executorSid","peer"});
      Require(Match(Str(policy,"pipeName"),"^ragent-run-credential-[a-f0-9]{32}$"),"RCC_POLICY_INVALID");
      foreach(string key in new[]{"controlSid","executorSid"})Require(Match(Str(policy,key),"^S-1-5-80-(?:[0-9]+-){4}[0-9]+$"),"RCC_POLICY_INVALID");
      Require(Str(policy,"controlSid")!=Str(policy,"executorSid"),"RCC_POLICY_INVALID");
      var binding=(Dictionary<string,object>)policy["binding"];Binding(binding);
      timer.Change(Num(binding,"expiresAtUnixMs")-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),Timeout.Infinite);
      Dictionary<string,object> self;using(var own=new ProcessPin(Process.GetCurrentProcess().Id))self=Facts(Process.GetCurrentProcess().Id,own.Handle);
      string local=Str(policy,server?"executorSid":"controlSid"),other=Str(policy,server?"controlSid":"executorSid");
      Require(Str(self,"sid")==local&&Num(self,"sessionId")==0&&Num(self,"integrityRid")==8192,"RCC_LOCAL_IDENTITY_DENIED");
      PermitPeerQuery(other);Emit(new{kind="identity",facts=self});
      stage="connect";
      using(var pipe=server?(PipeStream)Server(Str(policy,"pipeName"),local,other):Client(Str(policy,"pipeName"))){
        Dictionary<string,object> expected;
        if(server){var listener=(NamedPipeServerStream)pipe;Emit(new{kind="ready",facts=self,protectedDacl=listener.GetAccessControl().AreAccessRulesProtected,firstInstance=true,rejectRemote=true});listener.WaitForConnection();
          int pid;Require(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid),"RCC_PROCESS_UNAVAILABLE");using(var observed=new ProcessPin(pid))expected=Facts(pid,observed.Handle);
        }else expected=(Dictionary<string,object>)policy["peer"];
        Require(Str(expected,"sid")==other&&Num(expected,"sessionId")==0,"RCC_PEER_IDENTITY_DENIED");
        Dictionary<string,object> facts;using(var pinned=Pin(pipe,server,expected,out facts)){
          Require(Num(facts,"integrityRid")==8192,"RCC_PEER_IDENTITY_DENIED");stage="authenticate";
          string nonce;
          if(server){var bytes=new byte[32];using(var random=RandomNumberGenerator.Create())random.GetBytes(bytes);nonce=Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
            WriteFrame(pipe,Json.Serialize(Frame(binding,"run.channel.challenge",nonce,null)));
            CheckFrame(Parse(ReadFrame(pipe)),binding,"run.channel.confirm",nonce,false);WriteFrame(pipe,Json.Serialize(Frame(binding,"run.channel.ready",nonce,null)));
          }else{var challenge=Parse(ReadFrame(pipe));CheckFrame(challenge,binding,"run.channel.challenge",null,false);nonce=Str(challenge,"nonce");
            WriteFrame(pipe,Json.Serialize(Frame(binding,"run.channel.confirm",nonce,null)));CheckFrame(Parse(ReadFrame(pipe)),binding,"run.channel.ready",nonce,false);}
          Emit(new{kind="authenticated",facts=facts});stage="dispatch";
          if(server){var request=Parse(ReadFrame(pipe));CheckFrame(request,binding,"run.channel.dispatch",nonce,true);
            Emit(new{kind="request",facts=facts,payload=request["payload"]});var result=Parse(ParentLine());WriteFrame(pipe,Json.Serialize(Frame(binding,"run.channel.result",nonce,result)));
          }else{var request=Parse(ParentLine());WriteFrame(pipe,Json.Serialize(Frame(binding,"run.channel.dispatch",nonce,request)));
            var result=Parse(ReadFrame(pipe));CheckFrame(result,binding,"run.channel.result",nonce,true);Emit(new{kind="result",facts=facts,outcome=result["payload"]});}
        }
      }return 0;
    }catch(Exception error){var native=error as Win32Exception;Emit(new{kind="error",code=error is InvalidOperationException&&error.Message.StartsWith("RCC_")?error.Message:"RCC_TRANSPORT_FAILED",stage=stage,win32=native==null?0:native.NativeErrorCode});return 1;}
    finally{timer.Dispose();}
  }
}
