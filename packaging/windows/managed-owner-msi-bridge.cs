// Fixed administrative preparation/activation. No Owner authority is issued. Trusted PS resources are embedded, never caller-selected.
using System;using System.IO;using System.Text;using System.Linq;using System.Collections;
using System.Collections.Generic;using System.Diagnostics;using System.Management;
using System.Reflection;using System.Runtime.InteropServices;using System.Security.AccessControl;
using System.Security.Principal;using System.Security.Cryptography;using System.Text.RegularExpressions;using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;using AgentoC.ServiceHost;
using Microsoft.Win32;
static class ManagedOwnerMsiBridge {
 static string Product=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"AgentoC");
 static readonly string Data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"AgentoC");
 const string BrokerServiceName="AgentoC-PrivilegedBroker";
 const uint ScManagerConnect=0x0001,ServiceQueryConfig=0x0001,ServiceChangeConfig=0x0002,ServiceReadControl=0x00020000;
 const uint ServiceConfigSidInfo=5,ServiceConfigRequiredPrivileges=6,ServiceSidUnrestricted=1;
 const uint ServiceChangeConfigRight=0x0002,ServiceDeleteRight=0x00010000,ServiceStartRight=0x0010,ServiceStopRight=0x0020;
 const uint ServicePauseContinueRight=0x0040,ServiceUserControlRight=0x0100,WriteDacRight=0x00040000,WriteOwnerRight=0x00080000;
 const uint GenericWriteRight=0x40000000,GenericAllRight=0x10000000;
 [DllImport("msi.dll",CharSet=CharSet.Unicode,EntryPoint="MsiGetProductInfoW",ExactSpelling=true)]
 static extern uint MsiGetProductInfo(string productCode,string property,StringBuilder value,ref uint valueLength);
 static readonly string[] Names={"AgentoC-ControlPlane","AgentoC-RunnerSupervisor"};
 static string LegacyVoicePath(){
  string value=null;using(var settings=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\AgentoC\LocalVoiceSettings",false))
   if(settings!=null)value=settings.GetValue("RuntimeDirectory",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
  if(String.IsNullOrWhiteSpace(value))value=Path.Combine(Data,@"instances\owner\config\voice-runtime");
  if(!Regex.IsMatch(value,@"\A[A-Za-z]:\\")||value.StartsWith(@"\\",StringComparison.Ordinal))return null;
  string full;try{full=Path.GetFullPath(value).TrimEnd('\\');}catch{return null;}
  if(!String.Equals(Path.GetFileName(full),"voice-runtime",StringComparison.OrdinalIgnoreCase))return null;
  if(!full.StartsWith(Product.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)&&!full.StartsWith(Data.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))return null;
  return full;
 }
 static int RetireLegacyVoice(string action){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","VOICE_RETIRE_SYSTEM_REQUIRED");
  string runtime=LegacyVoicePath();if(runtime==null){Console.WriteLine("VOICE_RETIRE_UNMANAGED_PATH_PRESERVED");return 0;}
  if(action=="prepare")LegacyVoiceRetirement.Prepare(Product,Data,runtime);
  else LegacyVoiceRetirement.Finish(Product,Data,runtime,action=="rollback");
  Console.WriteLine("VOICE_RETIRE_"+action.ToUpperInvariant());return 0;
 }
 static readonly HashSet<string> Admins=new HashSet<string>(new[]{"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"});
 [StructLayout(LayoutKind.Sequential)]struct Attributes{public int size;public IntPtr sd;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateDirectory(string path,ref Attributes attributes);
 [StructLayout(LayoutKind.Sequential)]struct ServiceSidInfo{public uint serviceSidType;}
 [StructLayout(LayoutKind.Sequential)]struct RequiredPrivilegesInfo{public IntPtr requiredPrivileges;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct QueryServiceConfigInfo{
  public uint serviceType,startType,errorControl;public IntPtr binaryPathName,loadOrderGroup;public uint tagId;public IntPtr dependencies,serviceStartName,displayName;
 }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig(IntPtr service,IntPtr config,uint size,out uint needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryServiceConfig2(IntPtr service,uint level,IntPtr buffer,uint size,out uint needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ChangeServiceConfig2(IntPtr service,uint level,IntPtr info);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool QueryServiceObjectSecurity(IntPtr service,uint information,IntPtr descriptor,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool SetServiceObjectSecurity(IntPtr service,uint information,IntPtr descriptor);
 [DllImport("advapi32.dll")]static extern bool CloseServiceHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int processId);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref int size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint exitCode);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool CloseHandle(IntPtr handle);
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 static int UpgradeAdmission(string packageVersion,string productCode){
  Need(Regex.IsMatch(packageVersion,@"\A\d{1,5}(?:\.\d{1,5}){2}\z"),"OMI_PRODUCT_VERSION_INVALID");
  Guid parsedProductCode;Need(Guid.TryParseExact(productCode,"B",out parsedProductCode),"OMI_PRODUCT_CODE_INVALID");
  productCode=parsedProductCode.ToString("B").ToUpperInvariant();
  var installedVersionText=new StringBuilder(64);uint installedVersionLength=(uint)installedVersionText.Capacity;
  Need(MsiGetProductInfo(productCode,"VersionString",installedVersionText,ref installedVersionLength)==0,"OMI_INSTALLED_VERSION_UNAVAILABLE");
  string installedVersion=installedVersionText.ToString();Version package=null,installed=null;
  Need(Regex.IsMatch(installedVersion,@"\A\d{1,5}(?:\.\d{1,5}){2,3}\z")&&Version.TryParse(packageVersion,out package)&&Version.TryParse(installedVersion,out installed),"OMI_INSTALLED_VERSION_INVALID");
  // MSI ignores an installed package's fourth ProductVersion field. Compare
  // the same three fields that Windows Installer uses for upgrade ordering.
  installed=new Version(installed.Major,installed.Minor,installed.Build);
  // The same-version REINSTALL lane is an administrator-authorized repair.
  if(package.CompareTo(installed)<0){
   Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=false,code="OMI_UPDATE_OLDER",candidateVersion=packageVersion,installedVersion=installedVersion,readOnly=true,upgradeAdmitted=false,authorityIssued=false}));
   return 1;
  }
  return Run("UpgradeAdmission",null);
 }
 static void SetProductRoot(string value){
  Need(!String.IsNullOrWhiteSpace(value)&&value.Length<=32767&&Regex.IsMatch(value,@"\A[A-Za-z]:\\"),"OMI_INSTALL_ROOT_REQUIRED");
  string full=Path.GetFullPath(value).TrimEnd('\\');
  Need(full.Length>2&&!String.Equals(full,Path.GetPathRoot(full).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),"OMI_INSTALL_ROOT_REFUSED");
  Product=full;
 }
 static void CloseInstalledDesktop(){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_CLOSE_SYSTEM_REQUIRED");
  ValidateProductRoot();if(ActiveLayout())ActiveAdmission();else RemoveCheck(true);
  foreach(string name in new[]{"Ragent.exe","AgentoC.exe"})
   CloseProcessesForPath(Path.GetFullPath(Path.Combine(Product,"payload","Desktop",name)),false);
 }
 static void CloseCurrentUserDesktop(){
  ValidateProductRoot();if(ActiveLayout())ActiveAdmission();else RemoveCheck(true);
  foreach(string name in new[]{"Ragent.exe","AgentoC.exe"})
   CloseProcessesForPath(Path.GetFullPath(Path.Combine(Product,"payload","Desktop",name)),true);
 }
 static bool HasWindow(Process process){try{return process.MainWindowHandle!=IntPtr.Zero;}catch{return false;}}
 static bool MatchesDesktopImage(IntPtr handle,int pid,string image,string expected){
  if(String.Equals(Path.GetFullPath(image),expected,StringComparison.OrdinalIgnoreCase))return true;
  // MSI can move a mapped executable into its rollback folder while WMI
  // retains its original executable path. Accept that path only for an MSI
  // rollback image and bind the WMI row to the already-open process handle.
  string rollback=Path.Combine(Path.GetPathRoot(expected),"Config.Msi")+Path.DirectorySeparatorChar;
  if(!image.StartsWith(rollback,StringComparison.OrdinalIgnoreCase)||!image.EndsWith(".rbf",StringComparison.OrdinalIgnoreCase))return false;
  long creation,exit,kernel,user;if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user))return false;
  try{using(var query=new ManagementObjectSearcher("SELECT ExecutablePath,CreationDate FROM Win32_Process WHERE ProcessId="+pid))
   using(var rows=query.Get())foreach(ManagementObject row in rows){using(row){
    string path=row["ExecutablePath"] as string,created=row["CreationDate"] as string;
    if(String.IsNullOrEmpty(path)||String.IsNullOrEmpty(created))continue;
    var wmiTime=ManagementDateTimeConverter.ToDateTime(created).ToUniversalTime();
    if(Math.Abs((wmiTime-DateTime.FromFileTimeUtc(creation)).Ticks)<10000&&String.Equals(Path.GetFullPath(path),expected,StringComparison.OrdinalIgnoreCase))return true;
   }}
  }catch(ManagementException){}catch(UnauthorizedAccessException){}catch(ArgumentException){}
  return false;
 }
 static void CloseProcessesForPath(string expected,bool tolerateAccessDenied){
  for(int round=0;round<3;round++){
   // Windows Installer can rename an executable to a rollback filename while
   // its old image remains mapped. Its process name then no longer matches
   // AgentoC even though its executable path still identifies our desktop.
   int matched=0;var processes=Process.GetProcesses().OrderByDescending(HasWindow).ToArray();
   try{foreach(var process in processes){
    IntPtr handle=OpenProcess(0x1000|0x0001|0x00100000,false,process.Id);
    if(handle==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==87||error==1168||error==5)continue;throw new InvalidOperationException("OMI_CLOSE_PROCESS_OPEN_FAILED");}
    try{
     if(WaitForSingleObject(handle,0)==0)continue;
     var image=new StringBuilder(32768);int length=image.Capacity;
     if(!QueryFullProcessImageName(handle,0,image,ref length))continue;
     if(!MatchesDesktopImage(handle,process.Id,image.ToString(),expected))continue;
     matched++;
     bool requested=false;
     try{requested=process.CloseMainWindow();}catch(InvalidOperationException){}catch(System.ComponentModel.Win32Exception){}catch(NotSupportedException){}
     if(requested&&WaitForSingleObject(handle,3000)==0)continue;
     if(!TerminateProcess(handle,0)&&WaitForSingleObject(handle,0)!=0)throw new InvalidOperationException("OMI_CLOSE_PROCESS_TERMINATE_FAILED");
     Need(WaitForSingleObject(handle,10000)==0,"OMI_CLOSE_PROCESS_TIMEOUT");
    }finally{CloseHandle(handle);}
   }}finally{foreach(var process in processes)process.Dispose();}
   if(matched==0){Console.WriteLine("OMI_DESKTOP_CLOSED");return;}
  }
  throw new InvalidOperationException("OMI_CLOSE_PROCESS_RESPAWNING");
 }
 static string Hash(Stream stream){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 static void PinBrokerInputs(List<IDisposable> pins,string binary,string manifest){
  string broker=Path.GetDirectoryName(binary);Need(String.Equals(broker,Path.Combine(Product,"Broker"),StringComparison.OrdinalIgnoreCase),"OMI_BROKER_PATH_REFUSED");
  for(string path=Product;path!=null;path=Path.GetDirectoryName(path)){pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,true);if(String.Equals(Path.GetFullPath(path).TrimEnd('\\'),Path.GetPathRoot(path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))break;}
  pins.Add(ServiceDirectoryPin.Directory(broker));Acl(broker,true,true);
  foreach(string path in new[]{binary,manifest}){
   Need(File.Exists(path)&&(File.GetAttributes(path)&FileAttributes.ReparsePoint)==0,"OMI_BROKER_FILE_MISSING");
   var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);pins.Add(stream);ServiceDirectoryPin.VerifyFile(stream.SafeFileHandle,path);Acl(path,false,false);
  }
 }
 static QueryServiceConfigInfo ReadBrokerServiceConfig(IntPtr service){
  uint needed;QueryServiceConfig(service,IntPtr.Zero,0,out needed);Need(needed>0&&needed<=65536,"OMI_BROKER_SERVICE_CONFIG_UNAVAILABLE");
  IntPtr buffer=Marshal.AllocHGlobal((int)needed);try{Need(QueryServiceConfig(service,buffer,needed,out needed),"OMI_BROKER_SERVICE_CONFIG_UNAVAILABLE");return (QueryServiceConfigInfo)Marshal.PtrToStructure(buffer,typeof(QueryServiceConfigInfo));}finally{Marshal.FreeHGlobal(buffer);}
 }
 static void VerifyBrokerServiceDacl(IntPtr service){
  uint needed;QueryServiceObjectSecurity(service,5,IntPtr.Zero,0,out needed);Need(needed>0&&needed<=65536,"OMI_BROKER_SERVICE_ACL_UNAVAILABLE");
  IntPtr buffer=Marshal.AllocHGlobal((int)needed);try{
   Need(QueryServiceObjectSecurity(service,5,buffer,needed,out needed),"OMI_BROKER_SERVICE_ACL_UNAVAILABLE");
   byte[] bytes=new byte[(int)needed];Marshal.Copy(buffer,bytes,0,bytes.Length);var descriptor=new RawSecurityDescriptor(bytes,0);
   Need(descriptor.Owner!=null&&Admins.Contains(descriptor.Owner.Value)&&descriptor.DiscretionaryAcl!=null,"OMI_BROKER_SERVICE_ACL_REFUSED");
   int dangerous=unchecked((int)(ServiceChangeConfigRight|ServiceDeleteRight|ServiceStartRight|ServiceStopRight|ServicePauseContinueRight|ServiceUserControlRight|WriteDacRight|WriteOwnerRight|GenericWriteRight|GenericAllRight));
   string controlSid=new NTAccount("NT SERVICE","AgentoC-ControlPlane").Translate(typeof(SecurityIdentifier)).Value;bool controlQuery=false;
   foreach(GenericAce ace in descriptor.DiscretionaryAcl){
    if(ace.AceType==AceType.AccessDenied||ace.AceType==AceType.AccessDeniedObject)continue;
    var common=ace as CommonAce;Need(common!=null&&common.AceQualifier==AceQualifier.AccessAllowed,"OMI_BROKER_SERVICE_ACL_ACE_REFUSED");
    if(!Admins.Contains(common.SecurityIdentifier.Value))Need((common.AccessMask&dangerous)==0,"OMI_BROKER_SERVICE_ACL_MUTATION_REFUSED");
    if(common.SecurityIdentifier.Value==controlSid){Need(common.AccessMask==4,"OMI_BROKER_CONTROL_QUERY_RIGHTS_REFUSED");controlQuery=true;}
   }
   Need(controlQuery,"OMI_BROKER_CONTROL_QUERY_RIGHTS_REQUIRED");
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 static void SetBrokerServiceDacl(IntPtr service){
  string controlSid=new NTAccount("NT SERVICE","AgentoC-ControlPlane").Translate(typeof(SecurityIdentifier)).Value;
  var descriptor=new RawSecurityDescriptor("O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00000004;;;"+controlSid+")");byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);IntPtr buffer=Marshal.AllocHGlobal(bytes.Length);
  try{Marshal.Copy(bytes,0,buffer,bytes.Length);Need(SetServiceObjectSecurity(service,7,buffer),"OMI_BROKER_SERVICE_ACL_APPLY_FAILED");}finally{Marshal.FreeHGlobal(buffer);}
 }
 static void SetBrokerServiceConfiguration(IntPtr service,uint level,IntPtr info){Need(ChangeServiceConfig2(service,level,info),"OMI_BROKER_SERVICE_CONFIG_APPLY_FAILED");}
 static void VerifyBrokerServiceConfiguration(IntPtr service){
  var config=ReadBrokerServiceConfig(service);string binary=Marshal.PtrToStringUni(config.binaryPathName)??"";binary=binary.Trim();if(binary.Length>=2&&binary[0]=='"'&&binary[binary.Length-1]=='"')binary=binary.Substring(1,binary.Length-2);
  Need(config.serviceType==0x10&&config.startType==2&&String.Equals(Path.GetFullPath(binary),Path.Combine(Product,"Broker","AgentoC.PrivilegedBroker.exe"),StringComparison.OrdinalIgnoreCase),"OMI_BROKER_SERVICE_IDENTITY_REFUSED");
  string account=Marshal.PtrToStringUni(config.serviceStartName)??"";Need(String.Equals(account,"LocalSystem",StringComparison.OrdinalIgnoreCase)||String.Equals(account,@"NT AUTHORITY\LocalSystem",StringComparison.OrdinalIgnoreCase),"OMI_BROKER_SERVICE_ACCOUNT_REFUSED");
  IntPtr sidBuffer=Marshal.AllocHGlobal(4);try{uint needed;Need(QueryServiceConfig2(service,ServiceConfigSidInfo,sidBuffer,4,out needed),"OMI_BROKER_SERVICE_SID_QUERY_FAILED");Need((uint)Marshal.ReadInt32(sidBuffer)==ServiceSidUnrestricted,"OMI_BROKER_SERVICE_SID_REFUSED");}finally{Marshal.FreeHGlobal(sidBuffer);}
  IntPtr requiredBuffer=Marshal.AllocHGlobal(IntPtr.Size+256);try{uint needed;Need(QueryServiceConfig2(service,ServiceConfigRequiredPrivileges,requiredBuffer,(uint)(IntPtr.Size+256),out needed),"OMI_BROKER_REQUIRED_PRIVILEGES_QUERY_FAILED");IntPtr value=Marshal.ReadIntPtr(requiredBuffer);string privilege=Marshal.PtrToStringUni(value)??"";Need(privilege=="SeChangeNotifyPrivilege"&&Marshal.ReadInt16(value,(privilege.Length+1)*2)==0,"OMI_BROKER_REQUIRED_PRIVILEGES_REFUSED");}finally{Marshal.FreeHGlobal(requiredBuffer);}
  VerifyBrokerServiceDacl(service);
 }
 static void ConfigureBrokerService(string version,string expectedSha256){
  Need(Regex.IsMatch(version,@"\A\d+\.\d+\.\d+\.\d+\z")&&Regex.IsMatch(expectedSha256,@"\A[a-f0-9]{64}\z"),"OMI_BROKER_BUILD_ID_INVALID");
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_BROKER_CONFIG_SYSTEM_REQUIRED");ValidateProductRoot();
  string binary=Path.Combine(Product,"Broker","AgentoC.PrivilegedBroker.exe"),manifest=Path.Combine(Product,"Broker","AgentoC.PrivilegedBroker.manifest.json");var pins=new List<IDisposable>();
  try{
   PinBrokerInputs(pins,binary,manifest);var binaryStream=(FileStream)pins[pins.Count-2];string actualHash=Hash(binaryStream);Need(actualHash==expectedSha256,"OMI_BROKER_BINARY_HASH_REFUSED");
   var manifestStream=(FileStream)pins[pins.Count-1];string manifestText;manifestStream.Position=0;using(var reader=new StreamReader(manifestStream,new UTF8Encoding(false,true),true,1024,true))manifestText=reader.ReadToEnd();
   var record=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(manifestText);Need(record!=null&&record.Count==3&&record.ContainsKey("schemaVersion")&&Convert.ToInt32(record["schemaVersion"])==1&&record.ContainsKey("productVersion")&&String.Equals(Convert.ToString(record["productVersion"]),version,StringComparison.Ordinal)&&record.ContainsKey("sha256")&&String.Equals(Convert.ToString(record["sha256"]),expectedSha256,StringComparison.Ordinal),"OMI_BROKER_MANIFEST_REFUSED");
   IntPtr manager=OpenSCManager(null,null,ScManagerConnect);Need(manager!=IntPtr.Zero,"OMI_BROKER_SCM_CONNECT_FAILED");try{
    IntPtr service=OpenService(manager,BrokerServiceName,ServiceQueryConfig|ServiceChangeConfig|ServiceReadControl|WriteDacRight|WriteOwnerRight);Need(service!=IntPtr.Zero,"OMI_BROKER_SERVICE_MISSING");try{
     var config=ReadBrokerServiceConfig(service);string serviceBinary=Marshal.PtrToStringUni(config.binaryPathName)??"";serviceBinary=serviceBinary.Trim();if(serviceBinary.Length>=2&&serviceBinary[0]=='"'&&serviceBinary[serviceBinary.Length-1]=='"')serviceBinary=serviceBinary.Substring(1,serviceBinary.Length-2);
     Need(config.serviceType==0x10&&config.startType==2&&String.Equals(Path.GetFullPath(serviceBinary),binary,StringComparison.OrdinalIgnoreCase),"OMI_BROKER_SERVICE_IDENTITY_REFUSED");
     string serviceAccount=Marshal.PtrToStringUni(config.serviceStartName)??"";Need(String.Equals(serviceAccount,"LocalSystem",StringComparison.OrdinalIgnoreCase)||String.Equals(serviceAccount,@"NT AUTHORITY\LocalSystem",StringComparison.OrdinalIgnoreCase),"OMI_BROKER_SERVICE_ACCOUNT_REFUSED");SetBrokerServiceDacl(service);VerifyBrokerServiceDacl(service);
     var sid=new ServiceSidInfo{serviceSidType=ServiceSidUnrestricted};IntPtr sidPointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ServiceSidInfo)));try{Marshal.StructureToPtr(sid,sidPointer,false);SetBrokerServiceConfiguration(service,ServiceConfigSidInfo,sidPointer);}finally{Marshal.FreeHGlobal(sidPointer);}
     string multi="SeChangeNotifyPrivilege\0\0";IntPtr multiPointer=Marshal.StringToHGlobalUni(multi);IntPtr requiredPointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RequiredPrivilegesInfo)));try{Marshal.StructureToPtr(new RequiredPrivilegesInfo{requiredPrivileges=multiPointer},requiredPointer,false);SetBrokerServiceConfiguration(service,ServiceConfigRequiredPrivileges,requiredPointer);}finally{Marshal.FreeHGlobal(requiredPointer);Marshal.FreeHGlobal(multiPointer);}
     VerifyBrokerServiceConfiguration(service);
    }finally{CloseServiceHandle(service);}
   }finally{CloseServiceHandle(manager);}
  }finally{for(int index=pins.Count-1;index>=0;index--)pins[index].Dispose();}
 }
 // A major-upgrade rollback recreates the predecessor's service registration
 // from its old MSI, which did not author the service SID/privilege settings.
 // This action runs after that rollback and restores the verified old Broker.
 static void RestoreBrokerAfterMajorRollback(){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_BROKER_ROLLBACK_SYSTEM_REQUIRED");
  ValidateProductRoot();string binary=Path.Combine(Product,"Broker","AgentoC.PrivilegedBroker.exe"),manifest=Path.Combine(Product,"Broker","AgentoC.PrivilegedBroker.manifest.json");
  var pins=new List<IDisposable>();string version,hash;
  try{
   PinBrokerInputs(pins,binary,manifest);var binaryStream=(FileStream)pins[pins.Count-2];var manifestStream=(FileStream)pins[pins.Count-1];
   Need(manifestStream.Length>0&&manifestStream.Length<=8192,"OMI_BROKER_MANIFEST_REFUSED");
   string text;using(var reader=new StreamReader(manifestStream,new UTF8Encoding(false,true),true,1024,true))text=reader.ReadToEnd();
   var row=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text);
   Need(row!=null&&row.Count==3&&row.ContainsKey("schemaVersion")&&Convert.ToInt32(row["schemaVersion"])==1&&row.ContainsKey("productVersion")&&row.ContainsKey("sha256"),"OMI_BROKER_MANIFEST_REFUSED");
   version=Convert.ToString(row["productVersion"]);hash=Convert.ToString(row["sha256"]);
   Need(Regex.IsMatch(version??"",@"\A\d+\.\d+\.\d+\.\d+\z")&&Regex.IsMatch(hash??"",@"\A[a-f0-9]{64}\z")&&Hash(binaryStream)==hash,"OMI_BROKER_MANIFEST_REFUSED");
   ConfigureBrokerService(version,hash);
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
  using(var service=new System.ServiceProcess.ServiceController(BrokerServiceName)){
   service.Refresh();if(service.Status!=System.ServiceProcess.ServiceControllerStatus.Running){
    if(service.Status!=System.ServiceProcess.ServiceControllerStatus.Stopped)service.WaitForStatus(System.ServiceProcess.ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(60));
    service.Start();service.WaitForStatus(System.ServiceProcess.ServiceControllerStatus.Running,TimeSpan.FromSeconds(60));
   }
  }
  Console.WriteLine("OMI_BROKER_MAJOR_ROLLBACK_RESTORED");
 }
 static void ValidateProductRoot(){
  string target=Path.GetFullPath(Product).TrimEnd('\\');Need(target.Length>2,"OMI_INSTALL_ROOT_REFUSED");
  for(string path=target;path!=null;path=Path.GetDirectoryName(path)){
   if(!Directory.Exists(path))continue;
   var attributes=File.GetAttributes(path);Need((attributes&FileAttributes.ReparsePoint)==0&&(attributes&FileAttributes.Directory)!=0,"OMI_INSTALL_ROOT_REPARSE_REFUSED");
   Acl(path,true,!String.Equals(path,target,StringComparison.OrdinalIgnoreCase));
  }
 }
 static bool Present(string path){
  var chain=new List<string>();for(string p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p))chain.Add(p);chain.Reverse();
  foreach(string p in chain){try{var a=File.GetAttributes(p);Need((a&FileAttributes.ReparsePoint)==0,"OMI_REPARSE_REFUSED");Need(p==chain[chain.Count-1]||(a&FileAttributes.Directory)!=0,"OMI_PATH_UNSAFE");}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
  return true;
 }
 static Dictionary<string,object> ReadRemovalJson(string name,List<IDisposable> pins,out string digest){
  string path=Path.Combine(Product,name);Need(Present(path),"OMI_RECOVERY_RECEIPT_MISSING");
  var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
  try{
   ServiceDirectoryPin.VerifyFile(stream.SafeFileHandle,path);Acl(path,false,false);
   Need(stream.Length>=2&&stream.Length<=8192,"OMI_RECOVERY_RECEIPT_INVALID");
   digest=Hash(stream);stream.Position=0;
   string value;using(var reader=new StreamReader(stream,new UTF8Encoding(false,true),true,1024,true))value=reader.ReadToEnd();
   var record=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(value);
   Need(record!=null,"OMI_RECOVERY_RECEIPT_INVALID");pins.Add(stream);return record;
  }catch{stream.Dispose();throw;}
 }
 static Dictionary<string,object> RemovedAdmission(){
  Need(Present(Product)&&Present(Data),"OMI_EXISTING_INSTALL_REFUSED");ValidateProductRoot();
  Need(!Present(Path.Combine(Product,"owner-msi.prepare-lock")),"OMI_PREPARATION_INCOMPLETE");
  var pins=new List<IDisposable>();try{
   for(string path=Product;path!=null;path=Path.GetDirectoryName(path)){pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,true);}
   string markerHash,preparedHash,policyHash,activeHash;
   var marker=ReadRemovalJson("owner-msi.removed.json",pins,out markerHash);
   var prepared=ReadRemovalJson("owner-msi.prepared.activated.json",pins,out preparedHash);
   var policy=ReadRemovalJson("owner-msi.policy.activated.json",pins,out policyHash);
   var active=ReadRemovalJson("owner-msi.activated.json",pins,out activeHash);
   string[] keys={"version","purpose","phase","instanceId","ownerSid","preparedSha256","policySha256","activeSha256","removedAt"};
   Need(marker.Count==keys.Length&&keys.All(marker.ContainsKey)&&marker["version"] is int&&(int)marker["version"]==1
    &&(string)marker["purpose"]=="owner-msi-removal"&&(string)marker["phase"]=="services-removed"
    &&marker["instanceId"] is string&&Regex.IsMatch((string)marker["instanceId"],@"\Ainst_[a-f0-9]{32}\z")
    &&marker["ownerSid"] is string&&Regex.IsMatch((string)marker["ownerSid"],@"\AS-1-5-21-(\d+-){3}\d+\z")
    &&marker["removedAt"] is string,"OMI_RECOVERY_MARKER_INVALID");
   DateTime removed;Need(DateTime.TryParseExact((string)marker["removedAt"],"o",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.RoundtripKind,out removed),"OMI_RECOVERY_MARKER_INVALID");
   Need(new[]{"preparedSha256","policySha256","activeSha256"}.All(k=>marker[k] is string&&Regex.IsMatch((string)marker[k],@"\A[a-f0-9]{64}\z")),"OMI_RECOVERY_MARKER_INVALID");
   Need((string)marker["preparedSha256"]==preparedHash&&(string)marker["policySha256"]==policyHash&&(string)marker["activeSha256"]==activeHash,"OMI_RECOVERY_RECEIPT_CHANGED");
   Need(prepared.Count==4&&prepared.ContainsKey("version")&&prepared["version"] is int&&(int)prepared["version"]==1
    &&prepared.ContainsKey("purpose")&&(string)prepared["purpose"]=="owner-msi-preparation"
    &&prepared.ContainsKey("ownerSid")&&prepared["ownerSid"] is string&&(string)prepared["ownerSid"]==(string)marker["ownerSid"]
    &&prepared.ContainsKey("phase")&&(string)prepared["phase"]=="prepared"
    &&policy.ContainsKey("instanceId")&&(string)policy["instanceId"]==(string)marker["instanceId"]
    &&policy.ContainsKey("purpose")&&(string)policy["purpose"]=="owner-msi-policy-preparation"
    &&policy.ContainsKey("phase")&&(string)policy["phase"]=="policy-prepared"
    &&active.Count==8&&active.ContainsKey("instanceId")&&(string)active["instanceId"]==(string)marker["instanceId"]
    &&active.ContainsKey("purpose")&&(string)active["purpose"]=="owner-service-activation"
    &&active.ContainsKey("phase")&&(string)active["phase"]=="configuration-committed"
    &&active.ContainsKey("healthConfirmed")&&active["healthConfirmed"] is bool&&!(bool)active["healthConfirmed"]
    &&active.ContainsKey("preparedSha256")&&(string)active["preparedSha256"]==preparedHash
    &&active.ContainsKey("policyReceiptSha256")&&(string)active["policyReceiptSha256"]==policyHash
    &&Present(Path.Combine(Product,"owner-activation.committed-lock")),"OMI_RECOVERY_RECEIPT_INVALID");
   return marker;
  }finally{for(int index=pins.Count-1;index>=0;index--)pins[index].Dispose();}
 }
 static bool EmptyFreshTarget(string product,string data){
  if(Present(data))return false;
  if(!Present(product))return true;
  return Directory.Exists(product)&&!Directory.EnumerateFileSystemEntries(product).Any();
 }
 // A removed installation is useful for recovery only when its public
 // receipts match the protected Owner policy that survived uninstall.
 // This check is read-only; it never imports receipts or changes services.
 static void ValidateRecoverySource(string ownerSid){
  Need(ownerSid!=null&&Regex.IsMatch(ownerSid,@"\AS-1-5-21-(\d+-){3}\d+\z"),"OMI_OWNER_SID_REQUIRED");
  foreach(string name in Names)Need(!ServiceRows(name).Any(),"OMI_EXISTING_SERVICE_REFUSED");
  var removed=RemovedAdmission();
  Need(String.Equals((string)removed["ownerSid"],ownerSid,StringComparison.Ordinal),"OMI_RECOVERY_OWNER_MISMATCH");
  string policyPath=Path.Combine(Data,@"instances\owner\security\owner-bootstrap-install.json");
  Need(Present(policyPath),"OMI_RECOVERY_POLICY_MISSING");
  var pins=new List<IDisposable>();try{
   string receiptHash;
   var policyReceipt=ReadRemovalJson("owner-msi.policy.activated.json",pins,out receiptHash);
   Need(String.Equals(receiptHash,removed["policySha256"] as string,StringComparison.Ordinal)
    &&policyReceipt.ContainsKey("policySha256")&&policyReceipt.ContainsKey("instanceId")
    &&String.Equals(policyReceipt["instanceId"] as string,removed["instanceId"] as string,StringComparison.Ordinal),"OMI_RECOVERY_POLICY_MISMATCH");
   for(string path=Path.GetDirectoryName(policyPath);path!=null;path=Path.GetDirectoryName(path)){
    pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,true);
   }
   using(var stream=new FileStream(policyPath,FileMode.Open,FileAccess.Read,FileShare.Read)){
    ServiceDirectoryPin.VerifyFile(stream.SafeFileHandle,policyPath);Acl(policyPath,false,false);
    Need(stream.Length>=2&&stream.Length<=8192,"OMI_RECOVERY_POLICY_INVALID");
    Need(String.Equals(Hash(stream),policyReceipt["policySha256"] as string,StringComparison.Ordinal),"OMI_RECOVERY_POLICY_MISMATCH");
    stream.Position=0;
    string raw;using(var reader=new StreamReader(stream,new UTF8Encoding(false,true)))raw=reader.ReadToEnd();
    var policy=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(raw);
    Need(policy!=null&&policy.ContainsKey("instanceId")&&policy.ContainsKey("ownerSid")
     &&String.Equals(policy["instanceId"] as string,removed["instanceId"] as string,StringComparison.Ordinal)
     &&String.Equals(policy["ownerSid"] as string,ownerSid,StringComparison.Ordinal),"OMI_RECOVERY_POLICY_MISMATCH");
   }
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
 }
 static int ValidateRecoveryDestination(string ownerSid,string sourceRoot,string targetRoot,bool installedPayload=false){
  SetProductRoot(sourceRoot);string source=Product;
  ValidateRecoverySource(ownerSid);
  SetProductRoot(targetRoot);string target=Product;
  Need(!String.Equals(source,target,StringComparison.OrdinalIgnoreCase)
   &&!source.StartsWith(target+"\\",StringComparison.OrdinalIgnoreCase)
   &&!target.StartsWith(source+"\\",StringComparison.OrdinalIgnoreCase),"OMI_RECOVERY_PATHS_OVERLAP");
  ValidateProductRoot();
  if(!Present(target))return 0;
  Need(Directory.Exists(target),"OMI_INSTALL_ROOT_REFUSED");
  var allowed=new HashSet<string>(new[]{"owner-msi.prepared.activated.json","owner-msi.policy.activated.json",
   "owner-msi.activated.json","owner-msi.activation-health.json","owner-activation.committed-lock"},StringComparer.OrdinalIgnoreCase);
  int conflicts=0;var pins=new List<IDisposable>();try{
   for(string path=target;path!=null;path=Path.GetDirectoryName(path)){pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,true);}
   foreach(string path in Directory.EnumerateFileSystemEntries(target)){
    string name=Path.GetFileName(path);
    if(installedPayload&&new[]{"payload","Broker"}.Contains(name,StringComparer.OrdinalIgnoreCase)){
     Need(Present(path)&&Directory.Exists(path),"OMI_RECOVERY_TARGET_CONFLICT");
     pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,false);continue;
    }
    if(installedPayload&&String.Equals(name,"AgentoC.ServiceHost.exe",StringComparison.OrdinalIgnoreCase)){
     Need(Present(path)&&(File.GetAttributes(path)&FileAttributes.Directory)==0,"OMI_RECOVERY_TARGET_CONFLICT");
     var installedFile=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
     try{ServiceDirectoryPin.VerifyFile(installedFile.SafeFileHandle,path);Acl(path,false,false);pins.Add(installedFile);}catch{installedFile.Dispose();throw;}
     continue;
    }
    Need(allowed.Contains(name),"OMI_RECOVERY_TARGET_NOT_EMPTY");
    Need(Present(path)&&(File.GetAttributes(path)&FileAttributes.Directory)==0,"OMI_RECOVERY_TARGET_CONFLICT");
    var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
    try{ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);Acl(path,false,false);
     Need(file.Length>0&&file.Length<=8192,"OMI_RECOVERY_TARGET_CONFLICT");pins.Add(file);conflicts++;
    }catch{file.Dispose();throw;}
   }
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
  return conflicts;
 }
 static void PrepareRecoveryRelocation(string ownerSid,string source,string target){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_RELOCATION_SYSTEM_REQUIRED");
  ValidateRecoveryDestination(ownerSid,source,target,true);
  var pins=new List<IDisposable>();try{
   foreach(string root in new[]{Path.GetFullPath(source).TrimEnd('\\'),Product}){
    for(string path=root;path!=null;path=Path.GetDirectoryName(path)){pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,true);}
   }
   OwnerMsiRelocationJournal.Begin(source,Product,0);
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
 }
 static void FinishRecoveryRelocation(bool commit){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_RELOCATION_SYSTEM_REQUIRED");
  if(!Present(Path.Combine(Product,"owner-msi.relocation.json")))return;
  ValidateProductRoot();var pins=new List<IDisposable>();try{
   for(string path=Product;path!=null;path=Path.GetDirectoryName(path)){pins.Add(ServiceDirectoryPin.Directory(path));Acl(path,true,true);}
   if(commit)OwnerMsiRelocationJournal.Commit(Product);else OwnerMsiRelocationJournal.Rollback(Product);
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
 }
 static bool Fresh(){
  ValidateProductRoot();
  foreach(string n in Names)Need(!ServiceRows(n).Any(),"OMI_EXISTING_SERVICE_REFUSED");
  // Directory pickers often create the selected folder before MSI runs.
  // An empty, ACL-validated target is equivalent to an absent fresh target;
  // retained Owner data still requires the authenticated recovery path.
  if(EmptyFreshTarget(Product,Data))return false;
  Need(Present(Path.Combine(Product,"owner-msi.removed.json")),"OMI_EXISTING_INSTALL_REFUSED");
  RemovedAdmission();return true;
 }
 static List<Dictionary<string,object>> ServiceRows(string name){
  var result=new List<Dictionary<string,object>>();var options=new EnumerationOptions{Timeout=TimeSpan.FromSeconds(5),ReturnImmediately=false};
  using(var search=new ManagementObjectSearcher(new ManagementScope(@"\\.\root\cimv2"),new ObjectQuery("SELECT Name,StartName,State,StartMode,ProcessId FROM Win32_Service WHERE Name='"+name+"'"),options))
  using(var rows=search.Get()){foreach(ManagementObject row in rows)using(row){result.Add(new Dictionary<string,object>{{"name",row["Name"]},{"account",row["StartName"]},{"state",row["State"]},{"mode",row["StartMode"]},{"pid",row["ProcessId"]}});}}
  return result;
 }
 static void Acl(string path,bool directory,bool ancestor){
  FileSystemSecurity a=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
  Need(Admins.Contains(a.GetOwner(typeof(SecurityIdentifier)).Value),"OMI_INPUT_OWNER_REFUSED");
  foreach(FileSystemAccessRule rule in a.GetAccessRules(true,true,typeof(SecurityIdentifier))){if(rule.AccessControlType!=AccessControlType.Allow||(rule.PropagationFlags&PropagationFlags.InheritOnly)!=0||Admins.Contains(rule.IdentityReference.Value))continue;
   Need(((long)rule.FileSystemRights&(ancestor?0x500d0152L:0x500d0156L))==0,"OMI_INPUT_WRITABLE");}
 }
 static bool RemoveCheck(bool allowPolicy=false){
  Need(Directory.Exists(Product),"OMI_INSTALL_ROOT_MISSING");
  ValidateProductRoot();
  var pins=new List<IDisposable>();
  try{
   for(string p=Product;p!=null;p=Path.GetDirectoryName(p)){pins.Add(ServiceDirectoryPin.Directory(p));Acl(p,true,true);}
   string path=Path.Combine(Product,"owner-msi.prepared.json");
   using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
    Acl(path,false,false);Need(stream.Length>0&&stream.Length<8192,"OMI_RECEIPT_INVALID");
    string text;using(var reader=new StreamReader(stream,new UTF8Encoding(false,true)))text=reader.ReadToEnd();
    var r=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text);
    Need(r.Count==4&&r.ContainsKey("version")&&r["version"] is int&&(int)r["version"]==1&&r.ContainsKey("purpose")&&(string)r["purpose"]=="owner-msi-preparation"&&r.ContainsKey("phase")&&(string)r["phase"]=="prepared"&&r.ContainsKey("ownerSid")&&Regex.IsMatch((string)r["ownerSid"],@"\AS-1-5-21-(\d+-){3}\d+\z"),"OMI_RECEIPT_INVALID");
   }
   Need(!Present(Path.Combine(Product,"owner-msi.prepare-lock")),"OMI_PREPARATION_INCOMPLETE");
   Need(!Present(Path.Combine(Product,"owner-identity.initialize-lock")),"OMI_PREPARATION_INCOMPLETE");
   Need(!Present(Path.Combine(Product,"owner-activation.prepare-lock")),"OMI_PREPARATION_INCOMPLETE");
   Need(!Present(Path.Combine(Product,"owner-policy.prepare-lock")),"OMI_POLICY_PHASE_REFUSED");
   bool policy=Present(Path.Combine(Product,"owner-msi.policy.json"));Need(allowPolicy||!policy,"OMI_POLICY_PHASE_REFUSED");
   foreach(string n in Names){var rows=ServiceRows(n);Need(rows.Count==1,"OMI_SERVICE_STATE_REFUSED");var row=rows[0];Need(String.Equals((string)row["account"],@"NT SERVICE\"+n,StringComparison.OrdinalIgnoreCase)&&(string)row["state"]=="Stopped"&&(string)row["mode"]=="Disabled"&&Convert.ToUInt32(row["pid"])==0,"OMI_SERVICE_ACTIVE_OR_CHANGED");}
   return policy;
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
 }
 static bool ActiveLayout(){return Present(Path.Combine(Product,"owner-msi.activated.json"));}
 static int InstallRollback(){
  if(!Present(Product)){Console.WriteLine("OMI_ROLLBACK_NO_PRODUCT");return 0;}
  ValidateProductRoot();
  if(Present(Path.Combine(Product,"owner-msi.upgrade-transaction.json")))return Run("UpgradeRollback",null);
  if(Present(Path.Combine(Product,"owner-msi.removed.json"))){
   Console.WriteLine("OMI_ROLLBACK_RECOVERY_STATE_PRESERVED");return 0;
  }
  if(ActiveLayout()){
   ActiveAdmission();
   return Run("ActiveRemove",null);
  }
  string prepared=Path.Combine(Product,"owner-msi.prepared.json");
  if(Present(prepared)){
   bool policy=RemoveCheck(true);
   return Run(policy?"PolicyRemove":"Remove",null);
  }
  // The installation scripts keep durable locks after interrupted partial
  // work. Leave those quarantined inputs untouched; MSI's own rollback owns
  // the service/file rows it created before the embedded transaction began.
  Console.WriteLine("OMI_ROLLBACK_MSI_OWNS_PARTIAL_SETUP");return 0;
 }
 static int InstallCommit(){
  string marker=Path.Combine(Product,"owner-msi.removed.json");
  if(!Present(marker)){Console.WriteLine("OMI_COMMIT_FRESH");return 0;}
  Need(Present(Path.Combine(Product,"owner-msi.upgrade-transaction.json")),"OMI_RECOVERY_TRANSACTION_REQUIRED");
  Need((File.GetAttributes(marker)&FileAttributes.ReparsePoint)==0,"OMI_RECOVERY_MARKER_INVALID");Acl(marker,false,false);
  // The marker is cleared before the archive cleanup. If cleanup fails, the
  // still-present transaction journal drives the MSI rollback path above.
  File.Delete(marker);Need(!Present(marker),"OMI_RECOVERY_MARKER_CLEANUP_FAILED");
  int result=Run("UpgradeCommit",null);if(result!=0)return result;
  Console.WriteLine("OMI_RECOVERY_COMMITTED");return 0;
 }
 static bool PrevalidationMarker(){
  string path=Path.Combine(Product,"owner-msi.prevalidation-lock");
  if(!Present(path))return false;
  ValidateProductRoot();
  using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
   ServiceDirectoryPin.VerifyFile(stream.SafeFileHandle,path);Acl(path,false,false);
   Need(stream.Length>0&&stream.Length<=128,"OMI_PREVALIDATION_MARKER_INVALID");
   using(var reader=new StreamReader(stream,new UTF8Encoding(false,true)))Need(reader.ReadToEnd()=="agentoc-msi-prevalidation-v1\n","OMI_PREVALIDATION_MARKER_INVALID");
  }
  return true;
 }
 static int PrevalidationRollback(string version,string expectedSha256){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_PREVALIDATION_SYSTEM_REQUIRED");
  if(!PrevalidationMarker())return 0;
  int result=RemoveRollback(version,expectedSha256);if(result!=0)return result;
  string path=Path.Combine(Product,"owner-msi.prevalidation-lock");
  Need(PrevalidationMarker(),"OMI_PREVALIDATION_MARKER_INVALID");File.Delete(path);
  Need(!Present(path),"OMI_PREVALIDATION_MARKER_CLEANUP_FAILED");return 0;
 }
 static int PrevalidationStop(string version,string expectedSha256){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_PREVALIDATION_SYSTEM_REQUIRED");
  // A previous interrupted transaction can leave a protected marker. Restore
  // its services first; Windows Installer serializes execute transactions.
  if(PrevalidationMarker()){int restored=PrevalidationRollback(version,expectedSha256);if(restored!=0)return restored;}
  if(!ActiveLayout())return 0;
  ActiveAdmission();int admission=Run("ActiveRemoveCheck",null);if(admission!=0)return admission;
  return Run("PrevalidateStop",null);
 }
 static int PrevalidationCommit(){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_PREVALIDATION_SYSTEM_REQUIRED");
  if(!PrevalidationMarker())return 0;
  string path=Path.Combine(Product,"owner-msi.prevalidation-lock");File.Delete(path);
  Need(!Present(path),"OMI_PREVALIDATION_MARKER_CLEANUP_FAILED");return 0;
 }
 static int RemoveRollback(string version,string expectedSha256){
  Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_REMOVE_ROLLBACK_SYSTEM_REQUIRED");
  bool marker=Present(Path.Combine(Product,"owner-msi.removed.json"));
  // ActiveRemove deletes the two Owner registrations before MSI reaches
  // DeleteServices. A completed marker is the admission proof for recreating
  // those fixed registrations during rollback; ActiveAdmission requires them
  // to exist and therefore cannot be used in this phase.
  if(marker)RemovedAdmission();else ActiveAdmission(true);
  ConfigureBrokerService(version,expectedSha256);
  int result=Run("RemoveRollback",null);if(result!=0)return result;
  if(marker){
   string path=Path.Combine(Product,"owner-msi.removed.json");
   Need((File.GetAttributes(path)&FileAttributes.ReparsePoint)==0,"OMI_RECOVERY_MARKER_INVALID");Acl(path,false,false);
   File.Delete(path);Need(!Present(path),"OMI_REMOVE_ROLLBACK_MARKER_CLEANUP_FAILED");
  }
  Console.WriteLine("OMI_REMOVE_ROLLBACK_RESTORED_OWNER_RESET_RETAINED");return 0;
 }
 static void ActiveAdmission(bool allowRemovalLock=false){
  Need(Directory.Exists(Product),"OMI_INSTALL_ROOT_MISSING");ValidateProductRoot();
  var pins=new List<IDisposable>();try{
   for(string p=Product;p!=null;p=Path.GetDirectoryName(p)){pins.Add(ServiceDirectoryPin.Directory(p));Acl(p,true,true);}
   string pending=Path.Combine(Product,"owner-msi.prepare-lock");
   if(Present(pending)){
    Need(allowRemovalLock,"OMI_PREPARATION_INCOMPLETE");
    using(var f=new FileStream(pending,FileMode.Open,FileAccess.Read,FileShare.Read)){
     ServiceDirectoryPin.VerifyFile(f.SafeFileHandle,pending);Acl(pending,false,false);
     using(var r=new StreamReader(f,new UTF8Encoding(false,true)))Need(r.ReadToEnd()=="{\"version\":1,\"purpose\":\"owner-policy-removal\"}","OMI_REMOVAL_LOCK_INVALID");
    }
   }
   string path=Path.Combine(Product,"owner-msi.activated.json");using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
    ServiceDirectoryPin.VerifyFile(f.SafeFileHandle,path);Acl(path,false,false);Need(f.Length>0&&f.Length<=8192,"OMI_ACTIVE_RECEIPT_INVALID");
    string text;using(var reader=new StreamReader(f,new UTF8Encoding(false,true)))text=reader.ReadToEnd();var r=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text);
    Need(r!=null&&r.Count==8&&new[]{"version","purpose","phase","instanceId","preparedSha256","policyReceiptSha256","committedAt","healthConfirmed"}.All(r.ContainsKey)&&r["version"] is int&&(int)r["version"]==1&&(string)r["purpose"]=="owner-service-activation"&&(string)r["phase"]=="configuration-committed"&&Regex.IsMatch((string)r["instanceId"],@"\Ainst_[a-f0-9]{32}\z")&&r["healthConfirmed"] is bool&&!(bool)r["healthConfirmed"],"OMI_ACTIVE_RECEIPT_INVALID");
    DateTime committed;Need(new[]{"preparedSha256","policyReceiptSha256"}.All(k=>r[k] is string&&Regex.IsMatch((string)r[k],@"\A[a-f0-9]{64}\z"))&&r["committedAt"] is string&&DateTime.TryParseExact((string)r["committedAt"],"o",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.RoundtripKind,out committed),"OMI_ACTIVE_RECEIPT_INVALID");
   }
   // Provisional ordinary-client admission only; the deferred administrative
   // action revalidates all archives/policy/files and retains exact native leases.
   foreach(string name in Names){var rows=ServiceRows(name);Need(rows.Count==1&&String.Equals((string)rows[0]["account"],@"NT SERVICE\"+name,StringComparison.OrdinalIgnoreCase),"OMI_SERVICE_STATE_REFUSED");}
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
 }
 static int Run(string action,string owner){
  Need(Directory.Exists(Product),"OMI_INSTALL_ROOT_MISSING");ValidateProductRoot();
  Need(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),"OMI_ADMIN_REQUIRED");
  // Keep the private, transient installer workspace on the selected product
  // volume. This avoids filling the system drive when AgentoC is installed
  // elsewhere; the root is already ACL-validated above.
  string parent=Product,root=Path.Combine(parent,"AgentoC-managed-msi-"+Guid.NewGuid().ToString("N"));
  Need(Directory.Exists(parent),"OMI_TEMP_UNAVAILABLE");
  var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
  foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
  var bytes=acl.GetSecurityDescriptorBinaryForm();var sd=Marshal.AllocHGlobal(bytes.Length);bool owned=false;var pins=new List<IDisposable>();
  try{
   Marshal.Copy(bytes,0,sd,bytes.Length);var attr=new Attributes{size=Marshal.SizeOf(typeof(Attributes)),sd=sd,inherit=false};Need(CreateDirectory(root,ref attr),"OMI_TEMP_CREATE_REFUSED");owned=true;
   pins.Add(ServiceDirectoryPin.Directory(root));Acl(root,true,false);Need(Directory.GetAccessControl(root).AreAccessRulesProtected,"OMI_TEMP_ACL_REFUSED");
   var assembly=Assembly.GetExecutingAssembly();
   foreach(string name in new[]{"read-owner-bootstrap-discovery.ps1","prepare-owner-services.ps1","prepare-owner-service-data.ps1","managed-owner-msi.ps1","initialize-owner-service-identity.ps1","prepare-owner-install-policy.ps1","prepare-owner-msi-policy.ps1","prepare-owner-msi-upgrade.ps1","remove-owner-msi-policy.ps1","rollback-owner-msi-uninstall.ps1","prevalidate-owner-msi.ps1","check-owner-msi-upgrade.ps1","check-owner-msi-activation.ps1","owner-activation-service-read.cs","owner-service-activation-trial.cs","owner-service-activation-transaction.cs","AgentoC.ServiceHost.cs"}){
    using(var input=assembly.GetManifestResourceStream(name)){Need(input!=null,"OMI_RESOURCE_MISSING");using(var output=new FileStream(Path.Combine(root,name),FileMode.CreateNew,FileAccess.Write,FileShare.Read)){input.CopyTo(output);output.Flush(true);}}
    pins.Add(new FileStream(Path.Combine(root,name),FileMode.Open,FileAccess.Read,FileShare.Read));
   }
   string script=action=="PrevalidateStop"?"prevalidate-owner-msi.ps1":action=="RemoveRollback"?"rollback-owner-msi-uninstall.ps1":action=="UpgradeAdmission"?"check-owner-msi-upgrade.ps1":action.StartsWith("Upgrade",StringComparison.Ordinal)&&action!="UpgradeActivationCheck"&&action!="UpgradeActivate"?"prepare-owner-msi-upgrade.ps1":action=="ActivationCheck"||action=="Activate"||action=="UpgradeActivationCheck"||action=="UpgradeActivate"?"check-owner-msi-activation.ps1":action.StartsWith("PolicyRemove",StringComparison.Ordinal)||action.StartsWith("ActiveRemove",StringComparison.Ordinal)?"remove-owner-msi-policy.ps1":action=="Policy"?"prepare-owner-msi-policy.ps1":action=="Initialize"?"initialize-owner-service-identity.ps1":"managed-owner-msi.ps1";
   string scriptArguments="";
   if(action=="PrevalidateStop")scriptArguments=" -Action Stop";
   else if(action=="UpgradeAdmission")scriptArguments="";
   else if(action=="UpgradeActivationCheck")scriptArguments=" -Action Check -PreserveExistingIdentity";
   else if(action=="UpgradeActivate")scriptArguments=" -Action Activate -PreserveExistingIdentity";
   else if(action.StartsWith("Upgrade",StringComparison.Ordinal))scriptArguments=" -Action "+action.Substring("Upgrade".Length);
   else scriptArguments=" -Action "+(action=="ActivationCheck"||action=="PolicyRemoveCheck"?"Check":action=="PolicyRemove"?"Remove":action=="ActiveRemoveCheck"?"ActiveCheck":action);
   if(owner!=null)scriptArguments+=" -OwnerSid "+owner;
   // The process-only bypass is scoped to this embedded script, extracted into
   // the protected temporary root above; machine execution policy stays intact.
   string windowsRoot=Environment.GetFolderPath(Environment.SpecialFolder.Windows);Need(!String.IsNullOrWhiteSpace(windowsRoot)&&Path.IsPathRooted(windowsRoot),"OMI_WINDOWS_DIRECTORY_UNAVAILABLE");
   var info=new ProcessStartInfo{FileName=Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe"),Arguments="-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+Path.Combine(root,script)+"\""+scriptArguments,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
   string systemDrive=Path.GetPathRoot(windowsRoot).TrimEnd('\\');Need(Regex.IsMatch(systemDrive,@"\A[A-Za-z]:\z"),"OMI_SYSTEM_DRIVE_UNAVAILABLE");
   info.EnvironmentVariables.Clear();foreach(string key in new[]{"SystemRoot","WINDIR"})info.EnvironmentVariables[key]=windowsRoot;info.EnvironmentVariables["SystemDrive"]=systemDrive;info.EnvironmentVariables["AGENTOC_INSTALL_ROOT"]=Product;info.EnvironmentVariables["TEMP"]=info.EnvironmentVariables["TMP"]=root;
   using(var child=new Process{StartInfo=info})using(var outputDone=new System.Threading.ManualResetEventSlim())using(var errorDone=new System.Threading.ManualResetEventSlim()){
    var output=new StringBuilder();int errorBytes=0,overflow=0;
    child.OutputDataReceived+=(s,e)=>{if(e.Data==null){outputDone.Set();return;}lock(output){if(output.Length+e.Data.Length>65536)System.Threading.Interlocked.Exchange(ref overflow,1);else output.AppendLine(e.Data);}};
    child.ErrorDataReceived+=(s,e)=>{if(e.Data==null){errorDone.Set();return;}if(System.Threading.Interlocked.Add(ref errorBytes,e.Data.Length)>65536)System.Threading.Interlocked.Exchange(ref overflow,1);};
    Need(child.Start(),"OMI_CHILD_START_FAILED");child.BeginOutputReadLine();child.BeginErrorReadLine();
    if(!child.WaitForExit(action=="Activate"||action=="UpgradeActivate"||action=="ActiveRemove"||action=="PrevalidateStop"||action=="RemoveRollback"?240000:120000)){
     using(var killer=Process.Start(new ProcessStartInfo{FileName=Path.Combine(Environment.SystemDirectory,"taskkill.exe"),Arguments="/PID "+child.Id+" /T /F",UseShellExecute=false,CreateNoWindow=true}))killer.WaitForExit(15000);
     throw new InvalidOperationException("OMI_CHILD_TIMEOUT");
    }
    Need(outputDone.Wait(5000)&&errorDone.Wait(5000)&&overflow==0,"OMI_SCRIPT_OUTPUT_REFUSED");
    string value;lock(output)value=output.ToString();
    Dictionary<string,object> result=null;try{result=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(value);}catch{}
    Need(result!=null&&result.ContainsKey("ok")&&result["ok"] is bool&&((bool)result["ok"]==(child.ExitCode==0)),"OMI_SCRIPT_RESULT_INVALID");
    // Only typed public script results are forwarded. Never relay raw errors,
    // compiler output or an exception that might include private file contents.
    if(child.ExitCode!=0&&result.ContainsKey("code")&&result["code"] is string&&Regex.IsMatch((string)result["code"],@"\A[A-Z]{2,4}_[A-Z0-9_]{1,80}\z")){
     if(action=="Activate"){
      // Preserve only typed, non-secret state for a failed activation. The
      // protected runtime directory already exists from fresh preparation;
      // CreateNew prevents a second failure from overwriting prior evidence.
      try{
       string diagnosticPath=Path.Combine(Data, @"instances\owner\runtime\owner-msi-activation-failure.json");
       string diagnosticParent=Path.GetDirectoryName(diagnosticPath);Need(Present(diagnosticParent),"OMI_DIAGNOSTIC_PARENT_MISSING");
       var diagnostic=new Dictionary<string,object>{{"version",1},{"action",action},{"code",result["code"]}};
       foreach(string key in new[]{"stage","quarantine"})if(result.ContainsKey(key)&&result[key] is string&&((string)result[key]).Length<=80)diagnostic[key]=result[key];
       foreach(string key in new[]{"configurationCommitted","privateIdentityRead","mutationPerformed","servicesActivated","authorityIssued"})if(result.ContainsKey(key)&&result[key] is bool)diagnostic[key]=result[key];
       var diagnosticRows=result.ContainsKey("serviceDiagnostics")?result["serviceDiagnostics"] as IList:null;
       if(diagnosticRows!=null){
        var services=new List<Dictionary<string,object>>();foreach(object item in diagnosticRows){var row=item as Dictionary<string,object>;if(row==null||!row.ContainsKey("role")||!(row["role"] is string)||!new[]{"control","supervisor"}.Contains((string)row["role"]))continue;
        var safe=new Dictionary<string,object>{{"role",row["role"]}};foreach(string key in new[]{"lastStartError","lastProcessPinError","lastServiceState","lastServiceError","lastSpecificServiceError","lastServiceProcessId"})if(row.ContainsKey(key)&&(row[key] is int||row[key] is long))safe[key]=row[key];services.Add(safe);
        }diagnostic["serviceDiagnostics"]=services;
       }
       // Retain bounded health facts needed to diagnose activation, never the
       // HTTP body, local paths, or arbitrary error text.
       var health=result.ContainsKey("healthDiagnostics")?result["healthDiagnostics"] as Dictionary<string,object>:null;
       if(health!=null){
        var safe=new Dictionary<string,object>();
        foreach(string key in new[]{"attempts","httpStatus","pid","listenerCount","socketErrorCode"})if(health.ContainsKey(key)&&(health[key]==null||health[key] is int||health[key] is long))safe[key]=health[key];
        foreach(string key in new[]{"ok","pidIsInt32","healthCheckGatePassed","nodeProcessFound","nodeParentMatchesControl","nodeExecutableMatchesProductRoot","listenerOwnerMatches","ownerActivationReady"})if(health.ContainsKey(key)&&(health[key]==null||health[key] is bool))safe[key]=health[key];
        foreach(string key in new[]{"cliTransport","lastErrorType","webExceptionStatus","ownerActivationState","nodeProcessQuery"})if(health.ContainsKey(key)&&health[key] is string&&Regex.IsMatch((string)health[key],@"\A[A-Za-z0-9_-]{1,64}\z"))safe[key]=health[key];
        if(health.ContainsKey("ownerActivationCode")&&health["ownerActivationCode"] is string&&Regex.IsMatch((string)health["ownerActivationCode"],@"\A(?:OBC|OBD|OSV|OBP|OBS)_[A-Z_]+\z"))safe["ownerActivationCode"]=health["ownerActivationCode"];
        var logs=health.ContainsKey("serviceLogs")?health["serviceLogs"] as IList:null;
        if(logs!=null){var rows=new List<Dictionary<string,object>>();foreach(object item in logs){var row=item as Dictionary<string,object>;if(row==null||!row.ContainsKey("role")||!(row["role"] is string)||!new[]{"control","supervisor"}.Contains((string)row["role"]))continue;var log=new Dictionary<string,object>{{"role",row["role"]}};if(row.ContainsKey("present")&&row["present"] is bool)log["present"]=row["present"];if(row.ContainsKey("bytes")&&(row["bytes"] is int||row["bytes"] is long))log["bytes"]=row["bytes"];if(row.ContainsKey("tailSha256")&&row["tailSha256"] is string&&Regex.IsMatch((string)row["tailSha256"],@"\A[a-f0-9]{64}\z"))log["tailSha256"]=row["tailSha256"];foreach(string key in new[]{"errorCodes","classifications"})if(row.ContainsKey(key)&&row[key] is IList){var values=new List<string>();foreach(object logValue in (IList)row[key])if(logValue is string&&Regex.IsMatch((string)logValue,@"\A[A-Za-z0-9_-]{1,64}\z"))values.Add((string)logValue);log[key]=values;}rows.Add(log);}safe["serviceLogs"]=rows;}
        diagnostic["healthDiagnostics"]=safe;
       }
       byte[] diagnosticBytes=new UTF8Encoding(false,true).GetBytes(new JavaScriptSerializer().Serialize(diagnostic));
       using(var file=new FileStream(diagnosticPath,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){file.Write(diagnosticBytes,0,diagnosticBytes.Length);file.Flush(true);}
      }catch{}
     }
     // Keep a safe, typed failure reason in the existing application event
     // channel so MSI logs can be correlated with deferred Owner actions.
     // This deliberately records no path, identity, credential or payload.
     try{
      string detail="";
      if(action=="UpgradeAdmission"&&result.ContainsKey("failureLine")&&result["failureLine"] is int&&result.ContainsKey("failureHResult")&&result["failureHResult"] is int)
       detail=" line="+((int)result["failureLine"]).ToString(System.Globalization.CultureInfo.InvariantCulture)+" hresult="+((int)result["failureHResult"]).ToString(System.Globalization.CultureInfo.InvariantCulture);
      if(action=="UpgradeAdmission"&&result.ContainsKey("failureStage")&&result["failureStage"] is string&&Regex.IsMatch((string)result["failureStage"],@"\A[a-z-]{1,32}\z"))detail+=" stage="+(string)result["failureStage"];
      EventLog.WriteEntry("AgentoC","Owner MSI "+action+" failed: "+(string)result["code"]+detail,EventLogEntryType.Error,4101);
     }catch{}
    }
    Console.Out.Write(value);if(errorBytes>0)Console.Error.WriteLine("OMI_SCRIPT_STDERR");return child.ExitCode;
   }
  }finally{
   Marshal.FreeHGlobal(sd);for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();
   if(owned){Need(Path.GetDirectoryName(Path.GetFullPath(root))==parent&&Path.GetFileName(root).StartsWith("AgentoC-managed-msi-",StringComparison.Ordinal),"OMI_TEMP_CLEANUP_REFUSED");
    // Only these fresh administrator-private embedded resources/compiler output
    // exist here. Reject every reparse before recursive native cleanup.
    var stack=new Stack<string>();stack.Push(root);while(stack.Count>0){string dir=stack.Pop();Need((File.GetAttributes(dir)&FileAttributes.ReparsePoint)==0,"OMI_TEMP_REPARSE");foreach(string f in Directory.GetFileSystemEntries(dir)){var a=File.GetAttributes(f);Need((a&FileAttributes.ReparsePoint)==0,"OMI_TEMP_REPARSE");if((a&FileAttributes.Directory)!=0)stack.Push(f);}}
    Directory.Delete(root,true);
   }
  }
 }
 public static int Main(string[] args){
  try{
   Need(args.Length>0,"OMI_ARGUMENTS_REFUSED");
   if(args.Length==3&&args[0]=="recovery-source-check"){
    SetProductRoot(args[2]);ValidateRecoverySource(args[1]);Console.WriteLine("OMI_RECOVERY_SOURCE_VALID");return 0;
   }
   if(args.Length==4&&args[0]=="recovery-relocation-check"){
    int conflicts=ValidateRecoveryDestination(args[1],args[2],args[3]);
    Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,readOnly=true,targetConflicts=conflicts}));return 0;
   }
   if(args.Length==4&&args[0]=="fresh"){
    Need(args[1].Length<=184&&Regex.IsMatch(args[1],@"\AS-1-5-21-(\d+-){3}\d+\z"),"OMI_OWNER_SID_REQUIRED");
    if(String.IsNullOrWhiteSpace(args[3])||args[3]=="."){SetProductRoot(args[2]);Fresh();}
    else ValidateRecoveryDestination(args[1],args[3],args[2]);
    Console.WriteLine("OMI_FRESH_ADMITTED");return 0;
   }
   if(args.Length==4&&args[0]=="relocation-prepare"){
    PrepareRecoveryRelocation(args[1],args[2],args[3]);Console.WriteLine("OMI_RELOCATION_PREPARED");return 0;
   }
   if(args[0]=="fresh"&&args.Length==3){SetProductRoot(args[2]);}
   else if(args.Length>1&&Regex.IsMatch(args[args.Length-1],@"\A[A-Za-z]:\\")){
    SetProductRoot(args[args.Length-1]);args=args.Take(args.Length-1).ToArray();
   }
   if((args.Length>=1&&args.Length<=3)&&args[0]=="fresh"){
    if(args.Length>=2)Need(args[1].Length<=184&&Regex.IsMatch(args[1],@"\AS-1-5-21-(\d+-){3}\d+\z"),"OMI_OWNER_SID_REQUIRED");
    if(args.Length==3)Need(String.Equals(Path.GetFullPath(args[2]).TrimEnd('\\'),Product,StringComparison.OrdinalIgnoreCase),"OMI_FIXED_ROOT_REQUIRED");
    bool recovery=Fresh();Console.WriteLine(recovery?"OMI_RECOVERY_ADMITTED":"OMI_FRESH");return 0;
   }
   if(args.Length==3&&args[0]=="configure-broker-service"&&Regex.IsMatch(args[1],@"\A\d+\.\d+\.\d+\.\d+\z")&&Regex.IsMatch(args[2],@"\A[a-f0-9]{64}\z")){
    ConfigureBrokerService(args[1],args[2]);Console.WriteLine("OMI_BROKER_SERVICE_CONFIGURED");return 0;
   }
   if(args.Length==1&&args[0]=="restore-broker-after-major-rollback"){RestoreBrokerAfterMajorRollback();return 0;}
   // MSI immediate actions may still impersonate an ordinary client. This
   // admission only reads public state; the deferred non-impersonating Remove
   // repeats all privileged validation before any deletion or RemoveFiles.
   if(args.Length==1&&args[0]=="remove-admission"){if(ActiveLayout()){ActiveAdmission();Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,readOnly=true,requiresDeferredValidation=true,activeInstallation=true,authorityIssued=false}));return 0;}bool policy=RemoveCheck(true);Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,readOnly=true,requiresDeferredValidation=true,policyPrepared=policy,authorityIssued=false}));return 0;}
   if(args.Length==1&&args[0]=="close-desktop-current-user"){CloseCurrentUserDesktop();return 0;}
   if(args.Length==1&&args[0]=="close-desktop"){CloseInstalledDesktop();return 0;}
   if(args.Length==1&&args[0]=="remove-check"){if(ActiveLayout()){ActiveAdmission();return Run("ActiveRemoveCheck",null);}if(RemoveCheck(true))return Run("PolicyRemoveCheck",null);Console.WriteLine("OMI_REMOVABLE_PREPARED");return 0;}
   if(args.Length==1&&args[0]=="remove"){if(ActiveLayout()){ActiveAdmission();return Run("ActiveRemove",null);}return Run(RemoveCheck(true)?"PolicyRemove":"Remove",null);}
   if(args.Length==1&&args[0]=="initialize"){
    if(Present(Path.Combine(Product,"owner-msi.removed.json"))){Need(Present(Path.Combine(Product,"owner-msi.upgrade-transaction.json")),"OMI_RECOVERY_TRANSACTION_REQUIRED");Console.WriteLine("OMI_RECOVERY_IDENTITY_PRESERVED");return 0;}
    RemoveCheck();return Run("Initialize",null);
   }
   if(args.Length==1&&args[0]=="activate")return Run(Present(Path.Combine(Product,"owner-msi.removed.json"))?"UpgradeActivate":"Activate",null);
   if(args.Length==1&&args[0]=="activation-check")return Run(Present(Path.Combine(Product,"owner-msi.removed.json"))?"UpgradeActivationCheck":"ActivationCheck",null);
   if(args.Length==3&&args[0]=="upgrade-admission"){return UpgradeAdmission(args[1],args[2]);}
   if(args.Length==1&&args[0]=="upgrade-begin"){return Run("UpgradeBegin",null);}
   if(args.Length==1&&args[0]=="upgrade-prepare"){return Run("UpgradePrepare",null);}
   if(args.Length==1&&args[0]=="upgrade-policy"){return Run("UpgradePolicy",null);}
   if(args.Length==1&&args[0]=="upgrade-activation-check"){return Run("UpgradeActivationCheck",null);}
   if(args.Length==1&&args[0]=="upgrade-activate"){return Run("UpgradeActivate",null);}
   if(args.Length==1&&args[0]=="upgrade-rollback"){return Run("UpgradeRollback",null);}
   if(args.Length==1&&args[0]=="upgrade-commit"){return Run("UpgradeCommit",null);}
   if(args.Length==1&&args[0]=="voice-retire-prepare")return RetireLegacyVoice("prepare");
   if(args.Length==1&&args[0]=="voice-retire-rollback")return RetireLegacyVoice("rollback");
   if(args.Length==1&&args[0]=="voice-retire-commit")return RetireLegacyVoice("commit");
   if(args.Length==3&&args[0]=="prevalidate-stop")return PrevalidationStop(args[1],args[2]);
   if(args.Length==3&&args[0]=="prevalidate-rollback")return PrevalidationRollback(args[1],args[2]);
   if(args.Length==1&&args[0]=="prevalidate-commit")return PrevalidationCommit();
   if(args.Length==3&&args[0]=="remove-rollback")return RemoveRollback(args[1],args[2]);
   if(args.Length==1&&args[0]=="install-rollback")return InstallRollback();
   if(args.Length==1&&args[0]=="install-commit")return InstallCommit();
   if(args.Length==1&&args[0]=="relocation-rollback"){FinishRecoveryRelocation(false);return 0;}
   if(args.Length==1&&args[0]=="relocation-commit"){FinishRecoveryRelocation(true);return 0;}
   if(args.Length==1&&args[0]=="injected-failure"){
    Need(Directory.Exists(Product),"OMI_INSTALL_ROOT_MISSING");ValidateProductRoot();
    Need(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),"OMI_ADMIN_REQUIRED");
    Need(Present(Path.Combine(Product,"owner-msi.activated.json")),"OMI_ACTIVATION_COMMIT_REQUIRED");
    Need(Present(Path.Combine(Product,"owner-msi.activation-health.json")),"OMI_ACTIVATION_HEALTH_REQUIRED");
    Console.Error.WriteLine("OMI_INJECTED_POST_ACTIVATION_FAILURE");return 93;
   }
   if(args.Length==1&&args[0]=="injected-remove-failure"){
    Need(WindowsIdentity.GetCurrent().User.Value=="S-1-5-18","OMI_REMOVE_FAULT_SYSTEM_REQUIRED");
    RemovedAdmission();
    Console.Error.WriteLine("OMI_INJECTED_POST_REMOVAL_FAILURE");return 93;
   }
   if(args.Length==1&&args[0]=="policy"){
    if(Present(Path.Combine(Product,"owner-msi.removed.json"))){Need(Present(Path.Combine(Product,"owner-msi.upgrade-transaction.json")),"OMI_RECOVERY_TRANSACTION_REQUIRED");return Run("UpgradePolicy",null);}
    RemoveCheck();return Run("Policy",null);
   }
   if(args.Length==2&&args[0]=="prepare"&&args[1].Length<=184&&Regex.IsMatch(args[1],@"\AS-1-5-21-(\d+-){3}\d+\z")){
    if(Present(Path.Combine(Product,"owner-msi.removed.json"))){
     var removed=RemovedAdmission();Need((string)removed["ownerSid"]==args[1],"OMI_RECOVERY_OWNER_MISMATCH");
     int begin=Run("UpgradeBegin",null);if(begin!=0)return begin;
     return Run("UpgradePrepare",null);
    }
    return Run("Prepare",args[1]);
   }
   throw new InvalidOperationException("OMI_ARGUMENTS_REFUSED");
  }catch(Exception e){string code=e.GetBaseException().Message;string safe=Regex.IsMatch(code,@"\AOMI_[A-Z_]+\z")?code:"OMI_BRIDGE_FAILED";if(args.Length>0&&args[0]=="configure-broker-service"){try{EventLog.WriteEntry("AgentoC","Owner MSI Broker trust failed: "+safe,EventLogEntryType.Error,4102);}catch{}}else if(args.Length>0&&args[0]=="prepare"){try{EventLog.WriteEntry("AgentoC","Owner MSI prepare bridge failed: "+safe,EventLogEntryType.Error,4103);}catch{}}Console.Error.WriteLine(safe);return 1;}
 }
}
