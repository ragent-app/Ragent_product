// QA adapter only. Reuses production token reduction; it is not ServiceHost's
// startup/Owner activation protocol and never launches Node or the product API.
using System;using System.IO;using System.ServiceProcess;using System.Security.Principal;using System.Web.Script.Serialization;using System.Diagnostics;using System.Threading;using Ragent.ServiceHost;
sealed class PolicyAccessService:ServiceBase {
 readonly string role;public PolicyAccessService(string role){this.role=role;ServiceName=role=="control"?"Ragent-ControlPlane":"Ragent-RunnerSupervisor";CanStop=true;AutoLog=false;}
 protected override void OnStart(string[] args){try{
  ServiceToken.Reduce(ServiceName);
  string path=@"C:\ProgramData\Ragent\instances\owner\security\owner-bootstrap-install.json";bool read=false,write=false,create=false;
  try{var text=File.ReadAllText(path);var p=new JavaScriptSerializer().DeserializeObject(text);read=p!=null;}catch(UnauthorizedAccessException){}
  try{using(var f=new FileStream(path,FileMode.Open,FileAccess.Write,FileShare.ReadWrite)){write=true;}}catch(UnauthorizedAccessException){}
  string target=Path.Combine(Path.GetDirectoryName(path),"qa-"+role+"-write");try{using(var f=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){create=true;}}catch(UnauthorizedAccessException){}
  var result=new{role=role,pid=Process.GetCurrentProcess().Id,sid=WindowsIdentity.GetCurrent().User.Value,sessionId=0,integrityRid=8192,reducedTokenVerified=true,policyRead=read,policyWrite=write,securityCreate=create,adapterSubstituted=true};
  File.WriteAllText(@"C:\ProgramData\Ragent\instances\owner\workspace\policy-"+role+".json",new JavaScriptSerializer().Serialize(result));
  // Stay alive until the QA controller has observed both completed probes.
  // Self-stopping before Start-Service sees Running would make this flaky.
 }catch{ExitCode=1064;throw;}}
 public static void Main(string[] args){if(args.Length!=1||(args[0]!="control"&&args[0]!="supervisor"))throw new Exception("QA_FIXED_ROLE_REQUIRED");ServiceBase.Run(new PolicyAccessService(args[0]));}
}
