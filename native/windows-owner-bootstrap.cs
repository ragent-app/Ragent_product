// Dedicated Owner bootstrap. Private control-parent stdio; no Run/shell/credential-store API.
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

partial class WindowsOwnerBootstrap {
  const int Limit = 8192;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 12 };
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
      Require(value >= 0, "OBC_PARENT_DISCONNECTED");
      if (value == 10) break;
      Require(value != 13, "OBC_FRAME_INVALID");
      builder.Append((char)value); Require(builder.Length <= Limit, "OBC_FRAME_TOO_LARGE");
    }
    var line = builder.ToString(); Require(Utf8.GetByteCount(line) <= Limit, "OBC_FRAME_TOO_LARGE"); return line;
  }
  static byte[] ReadExact(Stream stream, int length) {
    var result = new byte[length]; int offset = 0;
    while (offset < length) { int count = stream.Read(result, offset, length-offset); Require(count > 0, "OBC_PEER_DISCONNECTED"); offset += count; }
    return result;
  }
  static string ReadFrame(Stream stream) {
    int length = BitConverter.ToInt32(ReadExact(stream, 4), 0);
    Require(length > 0 && length <= Limit, "OBC_FRAME_TOO_LARGE");
    return Utf8.GetString(ReadExact(stream, length));
  }
  static void WriteFrame(Stream stream, string value) {
    var bytes = Utf8.GetBytes(value); Require(bytes.Length > 0 && bytes.Length <= Limit, "OBC_FRAME_TOO_LARGE");
    var size = BitConverter.GetBytes(bytes.Length); stream.Write(size,0,4); stream.Write(bytes,0,bytes.Length); stream.Flush();
  }
  static IntPtr TokenData(IntPtr token,int kind) {
    int needed; GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);
    Require(needed>0 && needed<=65536,"OBC_TOKEN_UNAVAILABLE");
    IntPtr data=Marshal.AllocHGlobal(needed);
    if(!GetTokenInformation(token,kind,data,needed,out needed)){Marshal.FreeHGlobal(data);throw new InvalidOperationException("OBC_TOKEN_UNAVAILABLE");}
    return data;
  }
  static Dictionary<string, object> Facts(int pid, IntPtr process) {
    IntPtr token; Require(OpenProcessToken(process, 8, out token), "OBC_TOKEN_UNAVAILABLE");
    try {
      string userSid; int rid; bool admin=false,elevated;
      IntPtr data=TokenData(token,1);
      try { userSid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,25);
      try { IntPtr sid=Marshal.ReadIntPtr(data);rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(Marshal.ReadByte(GetSidSubAuthorityCount(sid))-1))); }
      finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,2);
      try {
        int count=Marshal.ReadInt32(data);Require(count>=0 && count<=1024,"OBC_TOKEN_UNAVAILABLE");
        int offset=IntPtr.Size==8?8:4, stride=IntPtr.Size==8?16:8;
        for(int i=0;i<count;i++){
          IntPtr entry=IntPtr.Add(data,offset+i*stride);
          int attrs=Marshal.ReadInt32(entry,IntPtr.Size);
          if((attrs&4)!=0 && (attrs&16)==0 && new SecurityIdentifier(Marshal.ReadIntPtr(entry)).Value=="S-1-5-32-544")admin=true;
        }
      } finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,20);try {elevated=Marshal.ReadInt32(data)!=0;} finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,29);try {Require(Marshal.ReadInt32(data)==0,"OBC_APPCONTAINER_DENIED");}finally {Marshal.FreeHGlobal(data);}
      Require(userSid!="S-1-5-18" && userSid!="S-1-5-19" && userSid!="S-1-5-20" && !admin && !elevated
        && rid>=8192 && rid<12288,"OBC_PEER_IDENTITY_UNSAFE");
      long created,exited,kernel,user;int session=-1;
      Require(GetProcessTimes(process,out created,out exited,out kernel,out user) && ProcessIdToSessionId(pid,out session),"OBC_PROCESS_UNAVAILABLE");
      return new Dictionary<string, object> { {"pid",pid}, {"createdTicks",created.ToString()},
        {"sid",userSid}, {"sessionId",session}, {"integrityRid",rid}, {"elevated",elevated}, {"enabledAdministrators",admin} };
    } finally { CloseHandle(token); }
  }
  sealed class ProcessPin:IDisposable {
    public IntPtr Handle;
    public ProcessPin(int pid){Handle=OpenProcess(0x1000,false,pid);Require(Handle!=IntPtr.Zero,"OBC_PROCESS_UNAVAILABLE");}
    public void Dispose(){if(Handle!=IntPtr.Zero){CloseHandle(Handle);Handle=IntPtr.Zero;}}
  }
  static void QueryAcl(IntPtr handle,string peerSid,int mask) {
    uint needed; GetKernelObjectSecurity(handle,4,null,0,out needed);
    Require(needed>0&&needed<=65536,"OBC_QUERY_ACL_SIZE");
    var bytes=new byte[needed];Require(GetKernelObjectSecurity(handle,4,bytes,needed,out needed),"OBC_QUERY_ACL_READ");
    var descriptor=new RawSecurityDescriptor(bytes,0);
    Require(descriptor.DiscretionaryAcl!=null,"OBC_QUERY_ACL_MISSING");
    descriptor.DiscretionaryAcl.InsertAce(descriptor.DiscretionaryAcl.Count,
      new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,mask,new SecurityIdentifier(peerSid),false,null));
    bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
    Require(SetKernelObjectSecurity(handle,4,bytes),"OBC_QUERY_ACL_WRITE");
  }
  static void PermitPeerQuery(string peer) {
    Require(System.Text.RegularExpressions.Regex.IsMatch(peer,"^S-1-5-(?:80|21)-(?:[0-9]+-){3,4}[0-9]+$"),"OBC_QUERY_POLICY_INVALID");
    IntPtr process=OpenProcess(0x60000,false,Process.GetCurrentProcess().Id);Require(process!=IntPtr.Zero,"OBC_SELF_DACL_UNAVAILABLE");
    try{QueryAcl(process,peer,0x1000);}finally{CloseHandle(process);}
    IntPtr token;Require(OpenProcessToken(Process.GetCurrentProcess().Handle,0x60008,out token),"OBC_SELF_TOKEN_DACL_UNAVAILABLE");
    try{QueryAcl(token,peer,8);}finally{CloseHandle(token);}
  }
  static void ProveQueryOnly(int pid,IntPtr process) {
    foreach(uint right in new uint[]{1,2,0x10,0x20,0x40,0x40000}){
      IntPtr other=OpenProcess(right,false,pid);if(other!=IntPtr.Zero){CloseHandle(other);throw new InvalidOperationException("OBC_PEER_PROCESS_AUTHORITY_EXCESS");}
      Require(Marshal.GetLastWin32Error()==5,"OBC_PEER_PROCESS_DENIAL_UNRESOLVED");
    }
    foreach(uint right in new uint[]{1,2,4,0x20,0x80}){
      IntPtr token;bool opened=OpenProcessToken(process,right,out token);
      if(opened){CloseHandle(token);throw new InvalidOperationException("OBC_PEER_TOKEN_AUTHORITY_EXCESS");}
      Require(Marshal.GetLastWin32Error()==5,"OBC_PEER_TOKEN_DENIAL_UNRESOLVED");
    }
  }
  static ProcessPin Pin(PipeStream pipe, bool server, IDictionary<string, object> expected, out Dictionary<string, object> facts) {
    int pid;
    bool found = server ? GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)
      : GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid);
    Require(found && pid == Num(expected,"pid"), "OBC_PEER_PID_MISMATCH");
    var process = new ProcessPin(pid);
    try {
      // Retain the opened Process HANDLE through the exchange, preventing a
      // recycled PID from being treated as the admitted endpoint.
      facts = Facts(pid,process.Handle);
      Require(Str(facts,"createdTicks") == Str(expected,"createdTicks")
        && Str(facts,"sid") == Str(expected,"sid")
        && Num(facts,"sessionId") == Num(expected,"sessionId"), "OBC_PEER_PIN_MISMATCH");
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
  static bool Match(string value,string pattern){return value!=null&&System.Text.RegularExpressions.Regex.IsMatch(value,pattern);}
  static long Version(IDictionary<string,object> policy){if(!policy.ContainsKey("protocolVersion"))return 1;Require(policy["protocolVersion"] is int||policy["protocolVersion"] is long,"OBC_POLICY_INVALID");return Num(policy,"protocolVersion");}
  static string Operation(IDictionary<string,object> policy,string phase){return (Version(policy)==1?"owner.bootstrap":"owner."+Str(policy,"purpose"))+(phase=="request"?"":"."+phase);}
  static void Policy(IDictionary<string,object> policy,bool server,IDictionary<string,object> self){
    bool v2=Version(policy)==2;var allowed=new HashSet<string>(new[]{"pipeName","instanceId","requestId","expiresAtUnixMs","controlSid","ownerSid","ownerSessionId"});
    if(v2){allowed.Add("protocolVersion");allowed.Add("purpose");Require(Str(policy,"purpose")=="browser"||Str(policy,"purpose")=="cli","OBC_PURPOSE_DENIED");}
    if(!server){allowed.Add("peer");if(v2){allowed.Add("launchNonce");Require(Match(Str(policy,"launchNonce"),"^[a-f0-9]{64}$"),"OBC_LAUNCH_NONCE_INVALID");}}
    Require(policy.Count==allowed.Count,"OBC_POLICY_INVALID");foreach(string key in policy.Keys)Require(allowed.Contains(key),"OBC_POLICY_INVALID");
    Require(Match(Str(policy,"pipeName"),"^ragent-owner-bootstrap-[a-f0-9]{32}$")&&Match(Str(policy,"instanceId"),@"\A(?:[a-f0-9-]{36}|inst_[a-f0-9]{32})\z")
      &&Match(Str(policy,"requestId"),"^[a-f0-9]{32}$"),"OBC_POLICY_INVALID");
    Require(Match(Str(policy,"controlSid"),"^S-1-5-80-(?:[0-9]+-){4}[0-9]+$")&&Match(Str(policy,"ownerSid"),"^S-1-5-21-(?:[0-9]+-){3}[0-9]+$")
      &&Num(policy,"ownerSessionId")>0&&Num(policy,"ownerSessionId")<=65535,"OBC_POLICY_INVALID");
    long remaining=Num(policy,"expiresAtUnixMs")-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();Require(remaining>0&&remaining<=30000,"OBC_DEADLINE_INVALID");
    Require(Str(self,"sid")==Str(policy,server?"controlSid":"ownerSid")&&Num(self,"sessionId")== (server?0:Num(policy,"ownerSessionId")),"OBC_LOCAL_IDENTITY_DENIED");
  }
  static void Message(IDictionary<string,object> frame,IDictionary<string,object> policy,string operation,string challenge,bool result,string launchNonce=null){
    bool v2=Version(policy)==2,hasLaunch=v2&&operation!=Operation(policy,"challenge"),browser=v2&&Str(policy,"purpose")=="browser";
    var fields=new HashSet<string>(new[]{"version","operation","instanceId","requestId","expiresAtUnixMs","challenge"});if(hasLaunch)fields.Add("launchNonce");if(result)fields.Add(browser?"bootstrapTicket":"sessionToken");
    Require(frame.Count==fields.Count,"OBC_FRAME_INVALID");
    foreach(string key in frame.Keys)Require(fields.Contains(key),"OBC_FRAME_INVALID");
    Require((frame["version"] is int||frame["version"] is long)&&Num(frame,"version")==Version(policy)&&Str(frame,"operation")==operation,"OBC_OPERATION_DENIED");
    Require(Str(frame,"instanceId")==Str(policy,"instanceId")&&Str(frame,"requestId")==Str(policy,"requestId")
      &&Num(frame,"expiresAtUnixMs")==Num(policy,"expiresAtUnixMs"),"OBC_BINDING_MISMATCH");
    Require(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()<Num(policy,"expiresAtUnixMs"),"OBC_EXPIRED");
    string nonce=Str(frame,"challenge");Require(Match(nonce,"^[A-Za-z0-9_-]{43}$"),"OBC_CHALLENGE_DENIED");
    if(challenge!=null){int delta=0;for(int i=0;i<43;i++)delta|=nonce[i]^challenge[i];Require(delta==0,"OBC_CHALLENGE_DENIED");}
    if(hasLaunch){Require(Match(Str(frame,"launchNonce"),"^[a-f0-9]{64}$"),"OBC_LAUNCH_NONCE_INVALID");if(launchNonce!=null)Require(Str(frame,"launchNonce")==launchNonce,"OBC_LAUNCH_NONCE_MISMATCH");}
    if(result)Require(Match(Str(frame,browser?"bootstrapTicket":"sessionToken"),"^[a-f0-9]{64}$"),"OBC_RESULT_INVALID");
  }
  static Dictionary<string,object> Challenge(IDictionary<string,object> policy){
    var bytes=new byte[32];using(var random=RandomNumberGenerator.Create())random.GetBytes(bytes);
    return new Dictionary<string,object>{{"version",Version(policy)},{"operation",Operation(policy,"challenge")},{"instanceId",Str(policy,"instanceId")},
      {"requestId",Str(policy,"requestId")},{"expiresAtUnixMs",Num(policy,"expiresAtUnixMs")},{"challenge",Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_')}};
  }
  public static int Main(string[] args){
    var watchdog=new Timer(_=>Environment.Exit(2),null,10000,Timeout.Infinite);string stage="bootstrap";
    try{
      Require(args.Length==1&&(args[0]=="server"||args[0]=="client"||args[0]=="facts"||args[0]=="peer-facts"||args[0]=="activation-server"||args[0]=="activation-client"),"OBC_MODE_INVALID");
      Dictionary<string,object> self;using(var own=new ProcessPin(Process.GetCurrentProcess().Id))self=Facts(Process.GetCurrentProcess().Id,own.Handle);
      if(args[0]=="facts"){Emit(new{kind="identity",facts=self});return 0;}
      if(args[0]=="peer-facts"){
        var expected=Parse(ParentLine());var keys=new HashSet<string>(new[]{"pid","createdTicks","ownerSid","ownerSessionId","controlSid"});
        Require(expected.Count==keys.Count,"OBC_POLICY_INVALID");foreach(var key in expected.Keys)Require(keys.Contains(key),"OBC_POLICY_INVALID");
        Require(Match(Str(expected,"controlSid"),@"\AS-1-5-80-(?:[0-9]+-){4}[0-9]+\z")&&Match(Str(expected,"ownerSid"),@"\AS-1-5-21-(?:[0-9]+-){3}[0-9]+\z")
          &&(expected["pid"] is int)&&Num(expected,"pid")>0&&Match(Str(expected,"createdTicks"),@"\A[0-9]{10,20}\z")
          &&(expected["ownerSessionId"] is int)&&Num(expected,"ownerSessionId")>0&&Num(expected,"ownerSessionId")<=65535,"OBC_POLICY_INVALID");
        Require(Str(self,"sid")==Str(expected,"controlSid")&&Num(self,"sessionId")==0,"OBC_LOCAL_IDENTITY_DENIED");
        int pid=(int)Num(expected,"pid");using(var peer=new ProcessPin(pid)){
          var actual=Facts(pid,peer.Handle);Require(Str(actual,"createdTicks")==Str(expected,"createdTicks")&&Str(actual,"sid")==Str(expected,"ownerSid")
            &&Num(actual,"sessionId")==Num(expected,"ownerSessionId")&&Num(actual,"integrityRid")==8192,"OBC_PEER_PIN_MISMATCH");
          ProveQueryOnly(pid,peer.Handle);actual["queryOnlyAuthorityVerified"]=true;Emit(new{kind="peer-identity",facts=actual,serviceFacts=self});return 0;
        }
      }
      if(args[0].StartsWith("activation-"))return Activation(args[0]=="activation-server",self,watchdog);
      bool server=args[0]=="server";stage="private-policy";var policy=Parse(ParentLine());Policy(policy,server,self);
      watchdog.Change(Num(policy,"expiresAtUnixMs")-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),Timeout.Infinite);
      PermitPeerQuery(Str(policy,server?"ownerSid":"controlSid"));Emit(new{kind="identity",facts=self});
      if(server){
        stage="pipe-create";using(var pipe=Server(Str(policy,"pipeName"),Str(policy,"controlSid"),Str(policy,"ownerSid"))){
          var acl=pipe.GetAccessControl();Emit(new{kind="ready",facts=self,protectedDacl=acl.AreAccessRulesProtected,dacl=acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access),firstInstance=true,rejectRemote=true});
          stage="connect";pipe.WaitForConnection();int pid;Require(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid),"OBC_PROCESS_UNAVAILABLE");
          using(var observed=new ProcessPin(pid)){
            var expected=Facts(pid,observed.Handle);Require(Str(expected,"sid")==Str(policy,"ownerSid")&&Num(expected,"sessionId")==Num(policy,"ownerSessionId"),"OBC_PEER_IDENTITY_DENIED");
            Dictionary<string,object> facts;using(var peer=Pin(pipe,true,expected,out facts)){
              stage="challenge";var challenge=Challenge(policy);WriteFrame(pipe,Json.Serialize(challenge));
              var frame=Parse(ReadFrame(pipe));Message(frame,policy,Operation(policy,"request"),Str(challenge,"challenge"),false);
              stage="issue";Emit(new{kind="request",facts=facts,frame=frame});
              var outcome=Parse(ParentLine());Message(outcome,policy,Operation(policy,"result"),Str(challenge,"challenge"),true,Version(policy)==2?Str(frame,"launchNonce"):null);WriteFrame(pipe,Json.Serialize(outcome));
              // A successful write alone does not prove that the pinned client
              // validated the result. V2 requires a secret-free, exact receipt.
              if(Version(policy)==2){stage="receipt";Message(Parse(ReadFrame(pipe)),policy,Operation(policy,"receipt"),Str(challenge,"challenge"),false,Str(frame,"launchNonce"));}
            }
          }
        }
      }else{
        stage="connect";using(var pipe=Client(Str(policy,"pipeName"))){
          var expected=(Dictionary<string,object>)policy["peer"];
          Require(Str(expected,"sid")==Str(policy,"controlSid")&&Num(expected,"sessionId")==0,"OBC_POLICY_INVALID");
          Dictionary<string,object> facts;using(var peer=Pin(pipe,false,expected,out facts)){
            stage="challenge";var challenge=Parse(ReadFrame(pipe));Message(challenge,policy,Operation(policy,"challenge"),null,false);
            challenge["operation"]=Operation(policy,"request");if(Version(policy)==2)challenge["launchNonce"]=Str(policy,"launchNonce");WriteFrame(pipe,Json.Serialize(challenge));
            stage="result";var result=Parse(ReadFrame(pipe));Message(result,policy,Operation(policy,"result"),Str(challenge,"challenge"),true,Version(policy)==2?Str(policy,"launchNonce"):null);
            if(Version(policy)==2){var receipt=new Dictionary<string,object>(challenge);receipt["operation"]=Operation(policy,"receipt");WriteFrame(pipe,Json.Serialize(receipt));}
            Emit(new{kind="result",facts=facts,outcome=result});
          }
        }
      }
      return 0;
    }catch(Exception error){var native=error as Win32Exception;string code=error is InvalidOperationException&&error.Message.StartsWith("OBC_")?error.Message:"OBC_TRANSPORT_FAILED";
      Emit(new{kind="error",code=code,stage=stage,type=error.GetType().Name,win32=native==null?0:native.NativeErrorCode});return 1;
    }finally{watchdog.Dispose();}
  }
}

// Separate domain: listening authorizes no session and returns no credential.
partial class WindowsOwnerBootstrap {
  static void ActivationPolicy(IDictionary<string,object> policy,bool server,IDictionary<string,object> self){
    var keys=new HashSet<string>(new[]{"domain","instanceId","controlSid","ownerSid","ownerSessionId"});
    Require(policy.Count==keys.Count,"OBC_ACTIVATION_POLICY_INVALID");foreach(var key in policy.Keys)Require(keys.Contains(key),"OBC_ACTIVATION_POLICY_INVALID");
    Require(Str(policy,"domain")=="owner.activation.v1"&&Match(Str(policy,"instanceId"),@"\A(?:[a-f0-9-]{36}|inst_[a-f0-9]{32})\z")
      &&Match(Str(policy,"controlSid"),@"\AS-1-5-80-(?:[0-9]+-){4}[0-9]+\z")&&Match(Str(policy,"ownerSid"),@"\AS-1-5-21-(?:[0-9]+-){3}[0-9]+\z")
      &&(policy["ownerSessionId"] is int||policy["ownerSessionId"] is long)&&Num(policy,"ownerSessionId")>=(server?0:1)&&Num(policy,"ownerSessionId")<=65535,"OBC_ACTIVATION_POLICY_INVALID");
    Require(Str(self,"sid")==Str(policy,server?"controlSid":"ownerSid")&&Num(self,"sessionId")== (server?0:Num(policy,"ownerSessionId")),"OBC_LOCAL_IDENTITY_DENIED");
  }
  static void ActivationFrame(IDictionary<string,object> frame,IDictionary<string,object> policy,string phase,IDictionary<string,object> original=null){
    var keys=new HashSet<string>(new[]{"version","operation","instanceId","requestId","expiresAtUnixMs","challenge"});if(phase!="challenge")keys.Add("launchNonce");
    Require(frame.Count==keys.Count,"OBC_ACTIVATION_FRAME_INVALID");foreach(var key in frame.Keys)Require(keys.Contains(key),"OBC_ACTIVATION_FRAME_INVALID");
    Require((frame["version"] is int||frame["version"] is long)&&Num(frame,"version")==1&&Str(frame,"operation")=="owner.activation."+phase,"OBC_OPERATION_DENIED");
    Require(Str(frame,"instanceId")==Str(policy,"instanceId")&&Match(Str(frame,"requestId"),@"\A[a-f0-9]{32}\z")
      &&Match(Str(frame,"challenge"),@"\A[A-Za-z0-9_-]{43}\z")&&(frame["expiresAtUnixMs"] is int||frame["expiresAtUnixMs"] is long),"OBC_BINDING_MISMATCH");
    long remaining=Num(frame,"expiresAtUnixMs")-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();Require(remaining>0&&remaining<=30000,"OBC_EXPIRED");
    if(phase!="challenge")Require(Match(Str(frame,"launchNonce"),@"\A[a-f0-9]{64}\z"),"OBC_LAUNCH_NONCE_INVALID");
    if(original!=null){foreach(string key in new[]{"instanceId","requestId","challenge","expiresAtUnixMs"})Require(Object.Equals(frame[key],original[key]),"OBC_BINDING_MISMATCH");
      if(original.ContainsKey("launchNonce"))Require(Str(frame,"launchNonce")==Str(original,"launchNonce"),"OBC_LAUNCH_NONCE_MISMATCH");}
  }
  static ProcessPin ActivationPin(PipeStream pipe,bool server,IDictionary<string,object> policy,out Dictionary<string,object> facts){
    int pid;Require(server?GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid):GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid),"OBC_PROCESS_UNAVAILABLE");
    // Obtain the expected creation time from the actual pipe PID while retaining
    // its process handle. No PID/creation/SID claim comes from the other peer.
    using(var observed=new ProcessPin(pid)){
      var expected=Facts(pid,observed.Handle);
      Require(Str(expected,"sid")==Str(policy,server?"ownerSid":"controlSid")&&(server&&Num(policy,"ownerSessionId")==0?
        Num(expected,"sessionId")>0:Num(expected,"sessionId")== (server?Num(policy,"ownerSessionId"):0)),"OBC_PEER_IDENTITY_DENIED");
      Require(Num(expected,"integrityRid")==8192,"OBC_PEER_IDENTITY_DENIED");
      return Pin(pipe,server,expected,out facts);
    }
  }
  static int Activation(bool server,Dictionary<string,object> self,Timer watchdog){
    var policy=Parse(ParentLine());ActivationPolicy(policy,server,self);
    // Idle listener lifetime is not an authorization deadline. After connect,
    // each authenticated request has its own immutable maximum 30s deadline.
    watchdog.Change(65000,Timeout.Infinite);
    PermitPeerQuery(Str(policy,server?"ownerSid":"controlSid"));Emit(new{kind="identity",facts=self});
    string name="ragent-owner-activation-"+Str(policy,"instanceId");
    if(server){using(var pipe=Server(name,Str(policy,"controlSid"),Str(policy,"ownerSid"))){
      Emit(new{kind="ready"});var connect=pipe.BeginWaitForConnection(null,null);
      bool completed=connect.AsyncWaitHandle.WaitOne(30000);
      try{
        // On timeout Dispose cancels the pipe, but the framework callback may
        // still be in flight. Leave its wait handle alive for the GC rather
        // than close it before the callback has finished signalling it.
        if(!completed){pipe.Dispose();throw new InvalidOperationException("OBC_ACTIVATION_IDLE");}
        pipe.EndWaitForConnection(connect);
      }finally{if(completed)connect.AsyncWaitHandle.Close();}
      Dictionary<string,object> facts;using(var peer=ActivationPin(pipe,true,policy,out facts)){
        var seed=new Dictionary<string,object>{{"instanceId",Str(policy,"instanceId")},{"requestId",Guid.NewGuid().ToString("N")},{"expiresAtUnixMs",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+30000}};
        var challenge=Challenge(seed);challenge["version"]=1;challenge["operation"]="owner.activation.challenge";
        watchdog.Change(30000,Timeout.Infinite);WriteFrame(pipe,Json.Serialize(challenge));
        var request=Parse(ReadFrame(pipe));ActivationFrame(request,policy,"request",challenge);Emit(new{kind="request",facts=facts,frame=request});
        var result=Parse(ParentLine());ActivationFrame(result,policy,"ready",request);WriteFrame(pipe,Json.Serialize(result));
        ActivationFrame(Parse(ReadFrame(pipe)),policy,"receipt",request);
        Emit(new{kind="receipt"});
        var committed=Parse(ParentLine());ActivationFrame(committed,policy,"committed",request);WriteFrame(pipe,Json.Serialize(committed));
      }
    }}else{NamedPipeClientStream connected=null;
      for(int attempt=0;connected==null;attempt++){
        try{connected=Client(name);}catch(Win32Exception error){if(attempt>=12||(error.NativeErrorCode!=2&&error.NativeErrorCode!=231))throw;Thread.Sleep(250);}
      }
      using(var pipe=connected){
      Dictionary<string,object> facts;using(var peer=ActivationPin(pipe,false,policy,out facts)){
        var challenge=Parse(ReadFrame(pipe));ActivationFrame(challenge,policy,"challenge");
        watchdog.Change(Num(challenge,"expiresAtUnixMs")-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),Timeout.Infinite);
        var request=new Dictionary<string,object>(challenge);request["operation"]="owner.activation.request";
        var bytes=new byte[32];using(var random=RandomNumberGenerator.Create())random.GetBytes(bytes);
        request["launchNonce"]=BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();WriteFrame(pipe,Json.Serialize(request));
        var result=Parse(ReadFrame(pipe));ActivationFrame(result,policy,"ready",request);
        var receipt=new Dictionary<string,object>(request);receipt["operation"]="owner.activation.receipt";WriteFrame(pipe,Json.Serialize(receipt));
        ActivationFrame(Parse(ReadFrame(pipe)),policy,"committed",request);
        Emit(new{kind="result",facts=facts});
      }
    }}return 0;
  }
}
