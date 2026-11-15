// Candidate local Run-only transport; no process launch, shell or Owner API.
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
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class RunPipeCandidate {
  const int Limit = 98304;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 12 };
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static readonly string[] Bindings = { "instanceId", "leaseId", "runId", "requestId", "grantId", "authorityHash" };
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
      Require(value >= 0, "IPC_PARENT_DISCONNECTED");
      if (value == 10) break;
      Require(value != 13, "IPC_FRAME_INVALID");
      builder.Append((char)value); Require(builder.Length <= Limit, "IPC_FRAME_TOO_LARGE");
    }
    var line = builder.ToString(); Require(Utf8.GetByteCount(line) <= Limit, "IPC_FRAME_TOO_LARGE"); return line;
  }
  static byte[] ReadExact(Stream stream, int length) {
    var result = new byte[length]; int offset = 0;
    while (offset < length) { int count = stream.Read(result, offset, length-offset); Require(count > 0, "IPC_PEER_DISCONNECTED"); offset += count; }
    return result;
  }
  static string ReadFrame(Stream stream) {
    int length = BitConverter.ToInt32(ReadExact(stream, 4), 0);
    Require(length > 0 && length <= Limit, "IPC_FRAME_TOO_LARGE");
    return Utf8.GetString(ReadExact(stream, length));
  }
  static void WriteFrame(Stream stream, string value) {
    var bytes = Utf8.GetBytes(value); Require(bytes.Length > 0 && bytes.Length <= Limit, "IPC_FRAME_TOO_LARGE");
    var size = BitConverter.GetBytes(bytes.Length); stream.Write(size,0,4); stream.Write(bytes,0,bytes.Length); stream.Flush();
  }
  static IntPtr TokenData(IntPtr token,int kind) {
    int needed; GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);
    Require(needed>0 && needed<=65536,"IPC_TOKEN_UNAVAILABLE");
    IntPtr data=Marshal.AllocHGlobal(needed);
    if(!GetTokenInformation(token,kind,data,needed,out needed)){Marshal.FreeHGlobal(data);throw new InvalidOperationException("IPC_TOKEN_UNAVAILABLE");}
    return data;
  }
  static Dictionary<string, object> Facts(int pid, IntPtr process) {
    IntPtr token; Require(OpenProcessToken(process, 8, out token), "IPC_TOKEN_UNAVAILABLE");
    try {
      string userSid; int rid; bool admin=false,elevated;
      IntPtr data=TokenData(token,1);
      try { userSid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; } finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,25);
      try { IntPtr sid=Marshal.ReadIntPtr(data);rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(Marshal.ReadByte(GetSidSubAuthorityCount(sid))-1))); }
      finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,2);
      try {
        int count=Marshal.ReadInt32(data);Require(count>=0 && count<=1024,"IPC_TOKEN_UNAVAILABLE");
        int offset=IntPtr.Size==8?8:4, stride=IntPtr.Size==8?16:8;
        for(int i=0;i<count;i++){
          IntPtr entry=IntPtr.Add(data,offset+i*stride);
          int attrs=Marshal.ReadInt32(entry,IntPtr.Size);
          if((attrs&4)!=0 && (attrs&16)==0 && new SecurityIdentifier(Marshal.ReadIntPtr(entry)).Value=="S-1-5-32-544")admin=true;
        }
      } finally {Marshal.FreeHGlobal(data);}
      data=TokenData(token,20);try {elevated=Marshal.ReadInt32(data)!=0;} finally {Marshal.FreeHGlobal(data);}
      Require(userSid!="S-1-5-18" && userSid!="S-1-5-19" && userSid!="S-1-5-20" && !admin && !elevated
        && rid>=8192 && rid<12288,"IPC_PEER_IDENTITY_UNSAFE");
      long created,exited,kernel,user;int session=-1;
      Require(GetProcessTimes(process,out created,out exited,out kernel,out user) && ProcessIdToSessionId(pid,out session),"IPC_PROCESS_UNAVAILABLE");
      return new Dictionary<string, object> { {"pid",pid}, {"createdTicks",created.ToString()},
        {"sid",userSid}, {"sessionId",session}, {"integrityRid",rid}, {"elevated",elevated}, {"enabledAdministrators",admin} };
    } finally { CloseHandle(token); }
  }
  sealed class ProcessPin:IDisposable {
    public IntPtr Handle;
    public ProcessPin(int pid){Handle=OpenProcess(0x1000,false,pid);Require(Handle!=IntPtr.Zero,"IPC_PROCESS_UNAVAILABLE");}
    public void Dispose(){if(Handle!=IntPtr.Zero){CloseHandle(Handle);Handle=IntPtr.Zero;}}
  }
  static void QueryAcl(IntPtr handle,string peerSid,int mask) {
    uint needed; GetKernelObjectSecurity(handle,4,null,0,out needed);
    Require(needed>0&&needed<=65536,"IPC_QUERY_ACL_SIZE");
    var bytes=new byte[needed];Require(GetKernelObjectSecurity(handle,4,bytes,needed,out needed),"IPC_QUERY_ACL_READ");
    var descriptor=new RawSecurityDescriptor(bytes,0);
    Require(descriptor.DiscretionaryAcl!=null,"IPC_QUERY_ACL_MISSING");
    descriptor.DiscretionaryAcl.InsertAce(descriptor.DiscretionaryAcl.Count,
      new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,mask,new SecurityIdentifier(peerSid),false,null));
    bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
    Require(SetKernelObjectSecurity(handle,4,bytes),"IPC_QUERY_ACL_WRITE");
  }
  static void PermitPeerQuery(IDictionary<string,object> policy,IDictionary<string,object> self) {
    string peer=Str(policy,"peerSid"),local=Str(self,"sid");
    Require(local!=peer&&local.StartsWith("S-1-5-80-")&&peer!=null&&peer.StartsWith("S-1-5-80-")
      &&Num(self,"sessionId")==0&&Num(policy,"peerSessionId")==0,"IPC_QUERY_POLICY_INVALID");
    // Each endpoint grants only its own process/token metadata to the other
    // exact virtual SID. No duplication, impersonation, VM or control rights.
    IntPtr process=OpenProcess(0x60000,false,Process.GetCurrentProcess().Id);
    Require(process!=IntPtr.Zero,"IPC_SELF_DACL_UNAVAILABLE");
    try{QueryAcl(process,peer,0x1000);}finally{CloseHandle(process);}
    IntPtr token;Require(OpenProcessToken(Process.GetCurrentProcess().Handle,0x60008,out token),"IPC_SELF_TOKEN_DACL_UNAVAILABLE");
    try{QueryAcl(token,peer,8);}finally{CloseHandle(token);}
  }
  static void ProveQueryOnly(int pid,IntPtr process) {
    foreach(uint right in new uint[]{1,2,0x10,0x20,0x40,0x40000}){
      IntPtr other=OpenProcess(right,false,pid);if(other!=IntPtr.Zero){CloseHandle(other);throw new InvalidOperationException("IPC_PEER_PROCESS_AUTHORITY_EXCESS");}
      Require(Marshal.GetLastWin32Error()==5,"IPC_PEER_PROCESS_DENIAL_UNRESOLVED");
    }
    foreach(uint right in new uint[]{1,2,4,0x20,0x80}){
      IntPtr token;bool opened=OpenProcessToken(process,right,out token);
      if(opened){CloseHandle(token);throw new InvalidOperationException("IPC_PEER_TOKEN_AUTHORITY_EXCESS");}
      Require(Marshal.GetLastWin32Error()==5,"IPC_PEER_TOKEN_DENIAL_UNRESOLVED");
    }
  }
  static ProcessPin Pin(PipeStream pipe, bool server, IDictionary<string, object> expected, out Dictionary<string, object> facts) {
    int pid;
    bool found = server ? GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)
      : GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid);
    Require(found && pid == Num(expected,"pid"), "IPC_PEER_PID_MISMATCH");
    var process = new ProcessPin(pid);
    try {
      // Retain the opened Process HANDLE through the exchange, preventing a
      // recycled PID from being treated as the admitted endpoint.
      facts = Facts(pid,process.Handle);
      Require(Str(facts,"createdTicks") == Str(expected,"createdTicks")
        && Str(facts,"sid") == Str(expected,"sid")
        && Num(facts,"sessionId") == Num(expected,"sessionId"), "IPC_PEER_PIN_MISMATCH");
      if(Str(facts,"sid")!=WindowsIdentity.GetCurrent().User.Value){ProveQueryOnly(pid,process.Handle);facts["queryOnlyAuthorityVerified"]=true;}
      return process;
    } catch { process.Dispose(); throw; }
  }
  static void CheckBinding(IDictionary<string, object> frame, IDictionary<string, object> binding) {
    Require(Num(frame,"version") == 1 && Str(frame,"operation") == "run.execute", "IPC_OPERATION_DENIED");
    foreach (var key in Bindings) Require(Str(frame,key) == Str(binding,key), "IPC_BINDING_MISMATCH");
    string actual = Str(frame,"capability"), expected = Str(binding,"capability");
    Require(actual != null && expected != null && actual.Length == 43 && expected.Length == 43, "IPC_CAPABILITY_DENIED");
    int delta = 0; for (int i=0;i<43;i++) delta |= actual[i]^expected[i]; Require(delta == 0, "IPC_CAPABILITY_DENIED");
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
  public static int Main(string[] args) {
    // Parent bootstrap itself is bounded even before policy arrives.
    var watchdog = new Timer(_ => Environment.Exit(2),null,15000,Timeout.Infinite);
    string stage="bootstrap";
    try {
      Require(args.Length == 1 && (args[0] == "server" || args[0] == "client"), "IPC_MODE_INVALID");
      bool server = args[0] == "server";
      stage="policy-read";
      var policy = Parse(ParentLine());
      string name = Str(policy,"pipeName");
      Require(name != null && System.Text.RegularExpressions.Regex.IsMatch(name,"^ragent-run-candidate-[a-f0-9]{32}$"), "IPC_PIPE_INVALID");
      long remaining = Num(policy,"expiresAtUnixMs") - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      Require(remaining > 0 && remaining <= 120000, "IPC_DEADLINE_INVALID");
      watchdog.Change(remaining,Timeout.Infinite);
      stage="local-token";
      Dictionary<string,object> self;
      using(var own=new ProcessPin(Process.GetCurrentProcess().Id))self=Facts(Process.GetCurrentProcess().Id,own.Handle);
      Require(Str(self,"sid") == Str(policy,"localSid") && Num(self,"sessionId") == Num(policy,"localSessionId"), "IPC_LOCAL_PIN_MISMATCH");
      if(policy.ContainsKey("permitVirtualPeerQuery")&&(bool)policy["permitVirtualPeerQuery"])PermitPeerQuery(policy,self);
      Emit(new { kind="identity",facts=self });
      var binding = (Dictionary<string,object>)policy["binding"];
      if (server) {
        stage="pipe-create";
        using (var pipe = Server(name,Str(self,"sid"),Str(policy,"peerSid"))) {
          var acl=pipe.GetAccessControl();
          Emit(new { kind="ready",facts=self,protectedDacl=acl.AreAccessRulesProtected,
            dacl=acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access),rejectRemote=true,firstInstance=true });
          var expected = Parse(ParentLine());
          Require(Str(expected,"sid") == Str(policy,"peerSid") && Num(expected,"sessionId") == Num(policy,"peerSessionId"), "IPC_POLICY_MISMATCH");
          pipe.WaitForConnection();
          Dictionary<string,object> facts;
          using (var peer = Pin(pipe,true,expected,out facts)) {
            var frame = Parse(ReadFrame(pipe)); CheckBinding(frame,binding);
            Emit(new { kind="request",facts=facts,frame=frame });
            var outcome = ParentLine();
            var parsed = Parse(outcome);
            foreach (var key in new [] {"leaseId","runId","requestId","grantId","authorityHash"})
              Require(Str(parsed,key) == Str(binding,key), "IPC_OUTCOME_BINDING_INVALID");
            WriteFrame(pipe,outcome);
          }
        }
      } else {
        var expected = (Dictionary<string,object>)policy["peer"];
        using (var pipe = Client(name)) {
          Dictionary<string,object> facts;
          using (var peer = Pin(pipe,false,expected,out facts)) {
            var frame = ParentLine(); CheckBinding(Parse(frame),binding); WriteFrame(pipe,frame);
            var outcome = Parse(ReadFrame(pipe));
            foreach (var key in new [] {"leaseId","runId","requestId","grantId","authorityHash"})
              Require(Str(outcome,key) == Str(binding,key), "IPC_OUTCOME_BINDING_INVALID");
            Emit(new { kind="result",facts=facts,outcome=outcome });
          }
        }
      }
      return 0;
    } catch (Exception error) {
      // Never print policy/frame/credentials or exception paths. Unknown
      // native errors expose only a stable category and numeric Win32 code.
      var native = error as Win32Exception;
      string code = error is InvalidOperationException && error.Message.StartsWith("IPC_") ? error.Message : "IPC_TRANSPORT_FAILED";
      Emit(new { kind="error",code=code,stage=stage,type=error.GetType().Name,hresult=error.HResult,
        win32=native == null ? 0 : native.NativeErrorCode }); return 1;
    } finally { watchdog.Dispose(); }
  }
}
