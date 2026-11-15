using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using Ragent.ServiceHost;

internal sealed class RunnerSupervisorServiceFixture : ServiceBase {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafePipeHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  readonly string role, root, publicName, backendName, serverName, clientName;
  readonly ManualResetEvent stopping = new ManualResetEvent(false);
  RunnerSupervisorPipe proxy; NamedPipeServerStream backend; Thread worker; volatile bool failure;
  RunnerSupervisorServiceFixture(string[] args) {
    role=args[0]; root=Path.GetFullPath(args[1]); publicName=args[2]; backendName=args[3]; serverName=args[4]; clientName=args[5];
    ServiceName=role=="server" ? serverName : clientName; CanStop=true;
  }
  protected override void OnStart(string[] args) { worker=new Thread(Run){IsBackground=true}; worker.Start(); }
  void Record(string name,string value) { File.WriteAllText(Path.Combine(root,name),value,new UTF8Encoding(false)); }
  void Run() {
    try {
      if(role=="server") {
        string serverSid=new NTAccount("NT SERVICE",serverName).Translate(typeof(SecurityIdentifier)).Value;
        string clientSid=new NTAccount("NT SERVICE",clientName).Translate(typeof(SecurityIdentifier)).Value;
        proxy=new RunnerSupervisorPipe(publicName,backendName,()=>System.Diagnostics.Process.GetCurrentProcess().Id,()=>failure=true,serverSid,clientSid);
        proxy.Start(); Record("server-ready.txt","ready");
        while(!stopping.WaitOne(0)) {
          try {
            backend=new NamedPipeServerStream(backendName,PipeDirection.InOut,10,PipeTransmissionMode.Byte,PipeOptions.Asynchronous);
            var waiting=backend.BeginWaitForConnection(null,null);
            if(WaitHandle.WaitAny(new WaitHandle[]{stopping,waiting.AsyncWaitHandle})==0)break;
            backend.EndWaitForConnection(waiting); using(var reader=new StreamReader(backend,Encoding.UTF8,false,1024,true)) {
              if(reader.ReadLine()!=null) { byte[] response=Encoding.UTF8.GetBytes("{\"ok\":true,\"pid\":42}\n"); backend.Write(response,0,response.Length); backend.Flush(); }
            }
          } catch { if(!stopping.WaitOne(0)) throw; } finally { if(backend!=null)backend.Dispose(); }
        }
      } else {
        var deadline=DateTime.UtcNow.AddSeconds(30);
        while(!File.Exists(Path.Combine(root,"server-ready.txt")) && DateTime.UtcNow<deadline)Thread.Sleep(50);
        if(!File.Exists(Path.Combine(root,"server-ready.txt")))throw new Exception("server not ready");
        for(int i=0;i<3;i++) using(var input=new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"health\"}\n"))) using(var output=new MemoryStream()) {
          int rc=RunnerSupervisorPipe.ClientCore(publicName,input,output,pipe=>BrokerPipeServerIdentity.VerifyService(pipe,serverName));
          if(rc!=0 || !Encoding.UTF8.GetString(output.ToArray()).Contains("\"pid\":42"))throw new Exception("cross-service forwarding failed");
        }
        Record("client-result.txt","PASS: distinct service accounts, exact SCM server PID, repeated requests");
      }
    } catch(Exception e) { failure=true; try {Record(role+"-error.txt",e.GetType().Name+": "+e.Message);}catch{} }
    finally { if(role=="client")try{Stop();}catch{} }
  }
  protected override void OnStop() {
    stopping.Set(); if(proxy!=null)proxy.Dispose(); if(worker!=null)worker.Join(5000); if(backend!=null)try{backend.Dispose();}catch{}
    if(failure)ExitCode=1;
  }
  public static int Main(string[] args) {
    if(args.Length==2 && args[0]=="--untrusted") {
      using(var handle=CreateFile(@"\\.\pipe\"+args[1],0x0012019b,0,IntPtr.Zero,3,0x00120000,IntPtr.Zero)) {
        if(!handle.IsInvalid || Marshal.GetLastWin32Error()!=5)return 1;
        Console.WriteLine("PASS: non-service client denied"); return 0;
      }
    }
    if(args.Length!=6 || (args[0]!="server" && args[0]!="client"))return 2;
    ServiceBase.Run(new RunnerSupervisorServiceFixture(args)); return 0;
  }
}
