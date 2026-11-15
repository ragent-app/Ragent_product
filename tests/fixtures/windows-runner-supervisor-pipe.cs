using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using Ragent.ServiceHost;

internal static class RunnerSupervisorPipeFixture {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetKernelObjectSecurity(SafePipeHandle pipe,uint info,byte[] data,uint length,out uint needed);
  static void Need(bool condition, string message) { if (!condition) throw new Exception(message); }
  static void CheckAcl(SafePipeHandle pipe, string owner, string control) {
    uint needed; GetKernelObjectSecurity(pipe,4,null,0,out needed); Need(needed>0 && needed<65536,"ACL unavailable");
    var bytes=new byte[needed]; Need(GetKernelObjectSecurity(pipe,4,bytes,needed,out needed),"ACL read failed");
    var descriptor=new RawSecurityDescriptor(bytes,0); Need((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected)!=0,"DACL not protected");
    bool ownerOk=false, controlOk=false, networkDeny=false;
    foreach(GenericAce raw in descriptor.DiscretionaryAcl) {
      var ace=raw as CommonAce; Need(ace!=null,"unexpected ACE"); string sid=ace.SecurityIdentifier.Value;
      if(sid==owner && ace.AceType==AceType.AccessAllowed) ownerOk=true;
      else if(sid==control && ace.AceType==AceType.AccessAllowed) { Need(ace.AccessMask==0x0012019b && (ace.AccessMask&4)==0,"client rights widened"); controlOk=true; }
      else if(sid=="S-1-5-2" && ace.AceType==AceType.AccessDenied) networkDeny=true;
      else Need(sid=="S-1-5-18" && ace.AceType==AceType.AccessAllowed,"unexpected principal");
    }
    Need(ownerOk && controlOk && networkDeny,"required ACL entry missing");
  }
  public static int Main() {
    string suffix=Guid.NewGuid().ToString("N"), pub="ragent-supervisor-qa-"+suffix, backend="ragent-supervisor-backend-"+Guid.NewGuid().ToString("N");
    string owner=WindowsIdentity.GetCurrent().User.Value, control="S-1-5-21-1-2-3-1001"; int handled=0; bool failed=false;
    var stop=new ManualResetEvent(false); NamedPipeServerStream pending=null;
    var server=new Thread(()=>{
      while(!stop.WaitOne(0)) {
        try {
          pending=new NamedPipeServerStream(backend,PipeDirection.InOut,10,PipeTransmissionMode.Byte,PipeOptions.None);
          pending.WaitForConnection(); using(var reader=new StreamReader(pending,Encoding.UTF8,false,1024,true)) {
            string line=reader.ReadLine(); if(line!=null) { Interlocked.Increment(ref handled); byte[] response=Encoding.UTF8.GetBytes("{\"ok\":true,\"pid\":42}\n"); pending.Write(response,0,response.Length); pending.Flush(); }
          }
        } catch { if(!stop.WaitOne(0)) failed=true; } finally { if(pending!=null)pending.Dispose(); }
      }
    }){IsBackground=true};
    try {
      server.Start();
      using(var proxy=new RunnerSupervisorPipe(pub,backend,()=>System.Diagnostics.Process.GetCurrentProcess().Id,()=>failed=true,owner,control)) {
        proxy.Start();
        for(int i=0;i<3;i++) {
          using(var input=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"health\"}\n"))) using(var output=new MemoryStream()) {
            int result=RunnerSupervisorPipe.ClientCore(pub,input,output,pipe=>{uint pid;Need(GetNamedPipeServerProcessId(pipe,out pid) && pid==(uint)System.Diagnostics.Process.GetCurrentProcess().Id,"server PID mismatch");CheckAcl(pipe,owner,control);});
            Need(result==0 && Encoding.UTF8.GetString(output.ToArray()).Contains("\"pid\":42"),"forwarding failed");
          }
        }
        int before=handled;
        using(var input=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"health\"}\n"))) using(var output=new MemoryStream())
          Need(RunnerSupervisorPipe.ClientCore(pub,input,output,pipe=>{throw new InvalidOperationException("spoof");})!=0,"spoof accepted");
        Thread.Sleep(100); Need(handled==before,"unverified client forwarded request"); Need(!failed,"listener failed");
        using(var input=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"health\"}\n"))) using(var output=new MemoryStream())
          Need(RunnerSupervisorPipe.ClientCore(pub,input,output,pipe=>BrokerPipeServerIdentity.VerifyService(pipe,"Ragent-RunnerSupervisor"))!=0,"foreign pipe accepted as installed service");
        Thread.Sleep(100); Need(handled==before,"foreign pipe received request");
        int successful=0; var workers=new Thread[6];
        for(int i=0;i<workers.Length;i++) {
          workers[i]=new Thread(()=>{ using(var input=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"health\"}\n"))) using(var output=new MemoryStream()) {
            if(RunnerSupervisorPipe.ClientCore(pub,input,output,pipe=>{uint pid;Need(GetNamedPipeServerProcessId(pipe,out pid) && pid==(uint)System.Diagnostics.Process.GetCurrentProcess().Id,"server PID mismatch");})==0) Interlocked.Increment(ref successful);
          }}); workers[i].Start();
        }
        foreach(var worker in workers)Need(worker.Join(35000),"concurrent request timed out"); Need(successful==workers.Length,"concurrent forwarding failed");
      }
      string fakePub="ragent-supervisor-qa-"+Guid.NewGuid().ToString("N"); int prior=handled;
      using(var proxy=new RunnerSupervisorPipe(fakePub,backend,()=>System.Diagnostics.Process.GetCurrentProcess().Id+1,()=>failed=true,owner,control)) {
        proxy.Start(); using(var input=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"health\"}\n"))) using(var output=new MemoryStream())
          Need(RunnerSupervisorPipe.ClientCore(fakePub,input,output,pipe=>{})!=0,"wrong backend PID accepted");
        Thread.Sleep(100); Need(handled==prior,"wrong backend received request");
      }
      Console.WriteLine("PASS: protected ACL, repeated forwarding, peer refusal and shutdown"); return 0;
    } catch(Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    finally { stop.Set(); if(pending!=null) try {pending.Dispose();}catch{} server.Join(3000); }
  }
}
