// Private fixed-root metadata/SCM transaction. Its public dispatcher MUST retain
// full trusted admission. QA may exercise this primitive with declared adapters;
// it cannot stand in for a genuine signed-helper/product activation positive.
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Security.Cryptography;using System.Security.Principal;using System.Security.AccessControl;using System.Runtime.InteropServices;using System.Web.Script.Serialization;using AgentoC.ServiceHost;
public sealed class OwnerServiceActivationTransaction:IDisposable {
 static readonly string Root=Path.GetFullPath(Environment.GetEnvironmentVariable("AGENTOC_INSTALL_ROOT")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"AgentoC")).TrimEnd('\\');
 static readonly string Marker=Path.Combine(Root,"owner-activation.prepare-lock");
 static readonly string CommittedMarker=Path.Combine(Root,"owner-activation.committed-lock");
 readonly OwnerServiceActivationTrial supervisor,control;readonly List<IDisposable> pins=new List<IDisposable>();
 readonly byte[] prepared,policy;readonly string instance;bool begun,committed,preparedModes;
 public bool ConfigurationCommitted{get{return committed;}}
 public bool Begun{get{return begun;}}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool MoveFileEx(string from,string to,uint flags);
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 static string Digest(byte[] b){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 static void SafeAcl(string path,bool directory){
  FileSystemSecurity a=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);var admins=new HashSet<string>(new[]{"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"});
  Need(admins.Contains(a.GetOwner(typeof(SecurityIdentifier)).Value),"OAX_INPUT_OWNER_REFUSED");foreach(FileSystemAccessRule rule in a.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&(rule.PropagationFlags&PropagationFlags.InheritOnly)==0&&!admins.Contains(rule.IdentityReference.Value))Need(((long)rule.FileSystemRights&(directory&&!String.Equals(path,Root,StringComparison.OrdinalIgnoreCase)?0x500d0152L:0x500d0156L))==0,"OAX_INPUT_WRITABLE");
 }
 static bool Present(string path){try{var a=File.GetAttributes(path);Need((a&FileAttributes.ReparsePoint)==0,"OAX_REPARSE_REFUSED");return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
 byte[] Read(string name){var path=Path.Combine(Root,name);using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);SafeAcl(path,false);Need(file.Length>0&&file.Length<=8192,"OAX_RECEIPT_SIZE_REFUSED");var bytes=new byte[(int)file.Length];int offset=0;while(offset<bytes.Length){int n=file.Read(bytes,offset,bytes.Length-offset);Need(n>0,"OAX_RECEIPT_READ_FAILED");offset+=n;}return bytes;}}
 void Match(string name,byte[] expected){Need(Convert.ToBase64String(Read(name))==Convert.ToBase64String(expected),"OAX_RECEIPT_CHANGED");}
 void Create(string name,object value){string path=Path.Combine(Root,name);var bytes=new UTF8Encoding(false,true).GetBytes(new JavaScriptSerializer().Serialize(value));using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){file.Write(bytes,0,bytes.Length);file.Flush(true);ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);SafeAcl(path,false);}}
 public OwnerServiceActivationTransaction(string instanceId,byte[] expectedPrepared,byte[] expectedPolicy,OwnerServiceActivationTrial supervisorLease,OwnerServiceActivationTrial controlLease){
  Need(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),"OAX_ADMIN_REQUIRED");Need(System.Text.RegularExpressions.Regex.IsMatch(instanceId??"",@"\Ainst_[a-f0-9]{32}\z"),"OAX_INSTANCE_REQUIRED");
  Need(supervisorLease!=null&&controlLease!=null&&supervisorLease.Name=="AgentoC-RunnerSupervisor"&&controlLease.Name=="AgentoC-ControlPlane","OAX_SERVICE_LEASES_REQUIRED");Need(expectedPrepared!=null&&expectedPolicy!=null&&expectedPrepared.Length>0&&expectedPrepared.Length<=8192&&expectedPolicy.Length>0&&expectedPolicy.Length<=8192,"OAX_RECEIPTS_REQUIRED");
  instance=instanceId;prepared=(byte[])expectedPrepared.Clone();policy=(byte[])expectedPolicy.Clone();supervisor=supervisorLease;control=controlLease;
  try{for(string p=Root;p!=null;p=Path.GetDirectoryName(p)){pins.Add(ServiceDirectoryPin.Directory(p));if(String.Equals(p,Root,StringComparison.OrdinalIgnoreCase))SafeAcl(p,true);}foreach(var name in new[]{"owner-activation.prepare-lock","owner-activation.committed-lock","owner-msi.activated.json","owner-msi.activation-health.json","owner-msi.prepared.activated.json","owner-msi.policy.activated.json","owner-msi.prepare-lock","owner-policy.prepare-lock","owner-identity.initialize-lock","owner-services.prepare-lock","owner-data.prepare-lock"})Need(!Present(Path.Combine(Root,name)),"OAX_EXISTING_TRANSACTION_REFUSED");Match("owner-msi.prepared.json",prepared);Match("owner-msi.policy.json",policy);}catch{Dispose();throw;}
 }
 public void Begin(){Need(!begun&&!committed,"OAX_STATE_REFUSED");begun=true;Create("owner-activation.prepare-lock",new{version=1,purpose="owner-service-activation",instanceId=instance,preparedSha256=Digest(prepared),policyReceiptSha256=Digest(policy)});}
 public void Prepare(){Need(begun&&!preparedModes&&!committed,"OAX_STATE_REFUSED");supervisor.PrepareAutomatic();control.PrepareAutomatic();preparedModes=true;}
 public void CommitConfiguration(){
  Need(begun&&preparedModes&&!committed,"OAX_STATE_REFUSED");supervisor.VerifyAutomaticStopped();control.VerifyAutomaticStopped();Match("owner-msi.prepared.json",prepared);Match("owner-msi.policy.json",policy);
  Need(MoveFileEx(Root+@"\owner-msi.prepared.json",Root+@"\owner-msi.prepared.activated.json",8),"OAX_PREPARED_ARCHIVE_FAILED");Need(MoveFileEx(Root+@"\owner-msi.policy.json",Root+@"\owner-msi.policy.activated.json",8),"OAX_POLICY_ARCHIVE_FAILED");
  Match("owner-msi.prepared.activated.json",prepared);Match("owner-msi.policy.activated.json",policy);
  Create("owner-msi.activated.json",new{version=1,purpose="owner-service-activation",phase="configuration-committed",instanceId=instance,preparedSha256=Digest(prepared),policyReceiptSha256=Digest(policy),committedAt=DateTime.UtcNow.ToString("o"),healthConfirmed=false});
  supervisor.VerifyAutomaticStopped();control.VerifyAutomaticStopped();Need(Present(Marker),"OAX_QUARANTINE_LOST");
  // Commit point. Before this rename host/native entry gates refuse startup.
  // After it the approved configuration is active, even if this caller dies;
  // healthy startup is a separate fact and is never inferred from this receipt.
  Need(MoveFileEx(Marker,CommittedMarker,8),"OAX_COMMIT_MARKER_FAILED");committed=true;Need(!Present(Marker)&&Present(CommittedMarker),"OAX_COMMIT_MARKER_REMAINS");
 }
 public void Start(){Need(committed,"OAX_COMMIT_REQUIRED");supervisor.Start();control.Start();}
 public void ConfirmHealth(){Need(committed,"OAX_COMMIT_REQUIRED");supervisor.VerifyRunning();control.VerifyRunning();Create("owner-msi.activation-health.json",new{version=1,purpose="owner-service-activation-health",instanceId=instance,supervisorPid=supervisor.ProcessId,controlPid=control.ProcessId,observation="service-processes-running",observedAt=DateTime.UtcNow.ToString("o")});}
 public string Quarantine(){
  Need(begun,"OAX_BEGIN_REQUIRED");if(!Present(Marker)){if(Present(CommittedMarker))Need(MoveFileEx(CommittedMarker,Marker,8),"OAX_REQUARANTINE_FAILED");else Create("owner-activation.prepare-lock",new{version=1,purpose="owner-service-activation-failed",instanceId=instance,configurationCommitted=committed});}
  string result="disabled";try{control.RestoreDisabled();}catch{result="drain-unconfirmed";}try{supervisor.RestoreDisabled();}catch{result="drain-unconfirmed";}return result;
 }
 // No destructor rollback or deletion of retained evidence. The caller owns
 // leases and explicitly quarantines on caught errors; crash semantics depend
 // on which side of the durable configuration commit point it reached.
 public void Dispose(){for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();pins.Clear();}
}
