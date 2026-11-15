// Query the actual compiled installed-layout gate on an actual prepared guest.
// Does not invoke OnStart, reduce this QA token, create data or start a service.
using System;using System.Reflection;using Ragent.ServiceHost;
static class PreparedMsiHostProbe {
 public static int Main(string[] args){
  if(args.Length>1||(args.Length==1&&args[0]!="activation-marker"))return 3;
  string expected=args.Length==0?"SHT_PREPARED_INSTALLATION_INACTIVE":"SHT_INSTALLATION_INCOMPLETE";
  var service=new RagentService("Ragent-ControlPlane","control",@"C:\Program Files\Ragent\payload\node.exe",@"C:\Program Files\Ragent\payload\chat-server.mjs",@"C:\Program Files\Ragent\payload",@"C:\ProgramData\Ragent\instances\owner\config",@"C:\ProgramData\Ragent\instances\owner");
  try{typeof(RagentService).GetMethod("ValidateInstalledLayout",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(service,null);return 1;}
  catch(TargetInvocationException e){if(e.InnerException.Message!=expected)return 2;Console.WriteLine(expected);return 0;}
 }
}
