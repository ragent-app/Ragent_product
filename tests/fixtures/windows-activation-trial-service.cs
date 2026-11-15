// QA service adapter, not production OnStart or trusted Owner activation.
using System;using System.IO;using System.Diagnostics;using System.ServiceProcess;using System.Security.Principal;using System.Web.Script.Serialization;using Ragent.ServiceHost;
sealed class ActivationTrialService:ServiceBase {
 readonly string role;ActivationTrialService(string role){this.role=role;ServiceName=role=="control"?"Ragent-ControlPlane":"Ragent-RunnerSupervisor";CanStop=true;AutoLog=false;}
 protected override void OnStart(string[] args){try{ServiceToken.Reduce(ServiceName);string root=@"C:\ProgramData\Ragent\instances\owner\workspace";bool before=role=="control"&&File.Exists(Path.Combine(root,"activation-control-fail-before")),after=role=="control"&&File.Exists(Path.Combine(root,"activation-control-fail-after"));
  File.WriteAllText(Path.Combine(root,"activation-"+role+".json"),new JavaScriptSerializer().Serialize(new{role=role,pid=Process.GetCurrentProcess().Id,sid=WindowsIdentity.GetCurrent().User.Value,sessionId=0,integrityRid=8192,reducedTokenVerified=true,adapterSubstituted=true,failurePhase=before?"before-running":after?"after-running":"none"}));
  if(before){System.Threading.Thread.Sleep(500);throw new InvalidOperationException("QA_DECLARED_CONTROL_START_FAILURE");}
  if(after)System.Threading.ThreadPool.QueueUserWorkItem(s=>{System.Threading.Thread.Sleep(1200);ExitCode=1064;Stop();});
 }catch{ExitCode=1064;throw;}}
 public static void Main(string[] args){if(args.Length!=1||(args[0]!="control"&&args[0]!="supervisor"))throw new Exception("QA_ROLE_REQUIRED");ServiceBase.Run(new ActivationTrialService(args[0]));}
}
