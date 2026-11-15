# Embedded MSI rollback action. MSI has restored the fixed service/file rows;
# owner.reset revocation remains effective and is never undone here.
[CmdletBinding()]
param([ValidateSet('RemoveRollback')][string]$Action)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'prepare-owner-service-data.ps1') -LibraryOnly
$stage='PLAN'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Security.AccessControl;
public static class OwnerMsiRollbackServiceTrust {
 [StructLayout(LayoutKind.Sequential)]struct Config {public uint type,start,error;public IntPtr command,group;public uint tag;public IntPtr dependencies,account,display;}
 [StructLayout(LayoutKind.Sequential)]struct Status {public uint type,state,controls,win32,service,checkpoint,hint,pid,flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",EntryPoint="CreateServiceW",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateService(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string command,string group,IntPtr tag,string dependencies,string account,string password);
 [DllImport("advapi32.dll",EntryPoint="ChangeServiceConfigW",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ChangeServiceConfig(IntPtr service,uint type,uint start,uint error,string command,string group,IntPtr tag,string dependencies,string account,string password,string display);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool SetServiceObjectSecurity(IntPtr service,uint information,byte[] descriptor);
 [DllImport("advapi32.dll",EntryPoint="QueryServiceConfigW",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig(IntPtr service,IntPtr config,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool QueryServiceStatusEx(IntPtr service,int kind,out Status status,int size,out int needed);
 [DllImport("advapi32.dll",EntryPoint="ChangeServiceConfig2W",SetLastError=true)]static extern bool ChangeServiceConfig2(IntPtr service,uint level,IntPtr info);
 [DllImport("advapi32.dll",EntryPoint="QueryServiceConfig2W",SetLastError=true)]static extern bool QueryServiceConfig2(IntPtr service,uint level,IntPtr buffer,uint size,out uint needed);
 [DllImport("advapi32.dll")]static extern bool CloseServiceHandle(IntPtr handle);
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 public static void Restore(string name,string expectedCommand,string expectedAccount){
  Need(name=="Ragent-ControlPlane"||name=="Ragent-RunnerSupervisor","ORR_SERVICE_NAME_REFUSED");
  IntPtr manager=OpenSCManager(null,null,3);Need(manager!=IntPtr.Zero,"ORR_SCM_OPEN_FAILED");
  try{IntPtr service=OpenService(manager,name,0x40007);
   if(service==IntPtr.Zero){
    Need(Marshal.GetLastWin32Error()==1060,"ORR_SERVICE_OPEN_FAILED");
    string dependencies=name=="Ragent-ControlPlane"?"Ragent-RunnerSupervisor\0\0":null;
    string display=name=="Ragent-ControlPlane"?"Ragent Control Plane":"Ragent Runner Supervisor";
    service=CreateService(manager,name,display,0xF01FF,16,2,1,expectedCommand,null,IntPtr.Zero,dependencies,expectedAccount,null);
    Need(service!=IntPtr.Zero,"ORR_SERVICE_RECREATE_FAILED");
   }
   try{uint n;QueryServiceConfig(service,IntPtr.Zero,0,out n);Need(n>0&&n<=65536,"ORR_SERVICE_CONFIG_INVALID");IntPtr memory=Marshal.AllocHGlobal((int)n);
    try{Need(QueryServiceConfig(service,memory,n,out n),"ORR_SERVICE_CONFIG_INVALID");var c=(Config)Marshal.PtrToStructure(memory,typeof(Config));
     string dependency=c.dependencies==IntPtr.Zero?"":Marshal.PtrToStringUni(c.dependencies);
     Need(c.type==16&&(c.start==2||c.start==4)&&Marshal.PtrToStringUni(c.command)==expectedCommand&&String.Equals(Marshal.PtrToStringUni(c.account),expectedAccount,StringComparison.OrdinalIgnoreCase)&&dependency==(name=="Ragent-ControlPlane"?"Ragent-RunnerSupervisor":""),"ORR_SERVICE_BINDING_CHANGED");
     if(c.start==4)Need(ChangeServiceConfig(service,0xffffffff,2,0xffffffff,null,null,IntPtr.Zero,null,null,null,null),"ORR_SERVICE_AUTO_REPAIR_FAILED");
    }finally{Marshal.FreeHGlobal(memory);}
    Status status;int needed;Need(QueryServiceStatusEx(service,0,out status,Marshal.SizeOf(typeof(Status)),out needed)&&status.state==1&&status.pid==0,"ORR_SERVICE_NOT_STOPPED");
    var descriptor=new RawSecurityDescriptor("O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)");
    var bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
    Need(SetServiceObjectSecurity(service,4,bytes),"ORR_SERVICE_ACL_REPAIR_FAILED");
    IntPtr sid=Marshal.AllocHGlobal(4);try{Marshal.WriteInt32(sid,1);Need(ChangeServiceConfig2(service,5,sid),"ORR_SERVICE_SID_REPAIR_FAILED");}finally{Marshal.FreeHGlobal(sid);}
    IntPtr privileges=Marshal.StringToHGlobalUni("SeChangeNotifyPrivilege\0\0"),info=Marshal.AllocHGlobal(IntPtr.Size);
    try{Marshal.WriteIntPtr(info,privileges);Need(ChangeServiceConfig2(service,6,info),"ORR_SERVICE_PRIVILEGES_REPAIR_FAILED");}finally{Marshal.FreeHGlobal(info);Marshal.FreeHGlobal(privileges);}
    IntPtr sidCheck=Marshal.AllocHGlobal(4);try{uint required;Need(QueryServiceConfig2(service,5,sidCheck,4,out required)&&Marshal.ReadInt32(sidCheck)==1,"ORR_SERVICE_SID_VERIFY_FAILED");}finally{Marshal.FreeHGlobal(sidCheck);}
    uint size;QueryServiceConfig2(service,6,IntPtr.Zero,0,out size);Need(size>=IntPtr.Size&&size<=65536,"ORR_SERVICE_PRIVILEGES_VERIFY_FAILED");
    IntPtr check=Marshal.AllocHGlobal((int)size);try{Need(QueryServiceConfig2(service,6,check,size,out size),"ORR_SERVICE_PRIVILEGES_VERIFY_FAILED");IntPtr value=Marshal.ReadIntPtr(check);string text=value==IntPtr.Zero?"":Marshal.PtrToStringUni(value);Need(text=="SeChangeNotifyPrivilege"&&Marshal.ReadInt16(value,(text.Length+1)*2)==0,"ORR_SERVICE_PRIVILEGES_VERIFY_FAILED");}finally{Marshal.FreeHGlobal(check);}
   }finally{CloseServiceHandle(service);}
  }finally{CloseServiceHandle(manager);}
 }
}
'@
try {
$product=Get-OwnerProductRoot
$plans=@(Get-OwnerServicePreparationPlan)
if($plans.Count -ne 2){throw 'ORR_SERVICE_PLAN_INVALID'}
$removalComplete=Test-Path -LiteralPath (Join-Path $product 'owner-msi.removed.json') -PathType Leaf
foreach($plan in $plans){
 $service=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'")
 if((-not $service -and -not $removalComplete) -or ($service -and ($service.PathName -cne $plan.command -or $service.StartName -ine $plan.account -or $service.StartMode -notin @('Auto','Disabled')))){
  throw 'ORR_SERVICE_BINDING_CHANGED'
 }
}
$broker=Get-CimInstance Win32_Service -Filter "Name='Ragent-PrivilegedBroker'"
$brokerPath=Join-Path $product 'Broker\Ragent.PrivilegedBroker.exe'
if(-not $broker -or $broker.PathName -cnotin @($brokerPath,('"'+$brokerPath+'"')) -or $broker.StartName -ine 'LocalSystem' -or $broker.StartMode -ne 'Auto'){
 throw 'ORR_BROKER_BINDING_CHANGED'
}
$stage='STOP'
foreach($name in @('Ragent-ControlPlane','Ragent-RunnerSupervisor')){
 $present=Get-Service -Name $name -ErrorAction SilentlyContinue
 if($present -and $present.Status -ne 'Stopped'){Stop-Service -Name $name -ErrorAction Stop}
}
$stage='CONFIGURE'
foreach($plan in $plans){[OwnerMsiRollbackServiceTrust]::Restore($plan.name,$plan.command,$plan.account)}
$stage='REMOVAL_LOCK'
$lock=Join-Path $product 'owner-msi.prepare-lock'
if(Test-Path -LiteralPath $lock){
 $pins=[Collections.Generic.List[IDisposable]]::new()
 try{
  $bytes=Read-OwnerPinnedFile $lock @(Get-OwnerAdministrativeSids) $pins 1024
  if([Text.UTF8Encoding]::new($false,$true).GetString($bytes) -cne '{"version":1,"purpose":"owner-policy-removal"}'){throw 'ORR_REMOVAL_LOCK_INVALID'}
 }finally{for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}}
 [IO.File]::Delete($lock)
}
$stage='BROKER_START'
if((Get-Service -Name 'Ragent-PrivilegedBroker' -ErrorAction Stop).Status -ne 'Running'){
 Start-Service -Name 'Ragent-PrivilegedBroker' -ErrorAction Stop
}
$stage='OWNER_START'
Start-Service -Name 'Ragent-RunnerSupervisor' -ErrorAction Stop
Start-Service -Name 'Ragent-ControlPlane' -ErrorAction Stop
$stage='VERIFY'
foreach($plan in $plans){
 $service=Get-CimInstance Win32_Service -Filter ("Name='"+$plan.name+"'")
 if(-not $service -or $service.State -ne 'Running' -or $service.PathName -cne $plan.command -or $service.StartName -ine $plan.account){throw 'ORR_SERVICE_RESTART_FAILED'}
}
if((Get-Service -Name 'Ragent-PrivilegedBroker' -ErrorAction Stop).Status -ne 'Running'){throw 'ORR_BROKER_RESTART_FAILED'}
@{ok=$true;servicesRestored=$true;brokerRestored=$true;ownerResetRetained=$true}|ConvertTo-Json -Compress
}catch{
 $code=$_.Exception.GetBaseException().Message
 if($code -cnotmatch '\AORR_[A-Z_]+\z'){$code='ORR_'+$stage+'_FAILED'}
 @{ok=$false;code=$code;stage=$stage;ownerResetRetained=$true}|ConvertTo-Json -Compress
 exit 1
}
