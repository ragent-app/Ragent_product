// Query-only retained handles for activation admission. No SCM mutation imports.
using System;
using System.Runtime.InteropServices;
public sealed class OwnerActivationServiceRead : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Config {public uint type,start,error;public IntPtr command,group;public uint tag;public IntPtr dependencies,account,display;}
 [StructLayout(LayoutKind.Sequential)] struct Status {public uint type,state,controls,win32,service,checkpoint,hint,pid,flags;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string a,string b,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryServiceConfig(IntPtr service,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryServiceConfig2(IntPtr service,uint kind,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service,int kind,out Status status,int size,out int needed);
 [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
 IntPtr handle;readonly string command,account,dependency;
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 public OwnerActivationServiceRead(string name,string expectedCommand){
  Need(name=="Ragent-ControlPlane"||name=="Ragent-RunnerSupervisor","OAC_SERVICE_NAME_REFUSED");
  Need(!String.IsNullOrEmpty(expectedCommand),"OAC_COMMAND_REQUIRED");command=expectedCommand;account=@"NT SERVICE\"+name;dependency=name=="Ragent-ControlPlane"?"Ragent-RunnerSupervisor":"";
  var manager=OpenSCManager(null,null,1);Need(manager!=IntPtr.Zero,"OAC_SCM_OPEN_REFUSED");
  try{handle=OpenService(manager,name,5);}finally{CloseServiceHandle(manager);}Need(handle!=IntPtr.Zero,"OAC_SERVICE_OPEN_REFUSED");
  try{Verify();}catch{Dispose();throw;}
 }
 public void Verify(){
  uint needed;QueryServiceConfig(handle,IntPtr.Zero,0,out needed);Need(needed>0&&needed<=65536,"OAC_CONFIG_QUERY_REFUSED");var data=Marshal.AllocHGlobal((int)needed);
  try{Need(QueryServiceConfig(handle,data,needed,out needed),"OAC_CONFIG_QUERY_REFUSED");var c=(Config)Marshal.PtrToStructure(data,typeof(Config));var dep=c.dependencies==IntPtr.Zero?"":Marshal.PtrToStringUni(c.dependencies);
   Need(c.type==16&&c.start==4&&Marshal.PtrToStringUni(c.command)==command&&String.Equals(Marshal.PtrToStringUni(c.account),account,StringComparison.OrdinalIgnoreCase)&&dep==dependency,"OAC_SERVICE_CONFIGURATION_CHANGED");
   if(dep.Length>0)Need(Marshal.ReadInt16(c.dependencies,(dep.Length+1)*2)==0,"OAC_SERVICE_CONFIGURATION_CHANGED");
  }finally{Marshal.FreeHGlobal(data);}
  QueryServiceConfig2(handle,6,IntPtr.Zero,0,out needed);Need(needed>=IntPtr.Size&&needed<=65536,"OAC_PRIVILEGES_QUERY_REFUSED");data=Marshal.AllocHGlobal((int)needed);
  try{Need(QueryServiceConfig2(handle,6,data,needed,out needed),"OAC_PRIVILEGES_QUERY_REFUSED");var text=Marshal.ReadIntPtr(data);var privilege=text==IntPtr.Zero?"":Marshal.PtrToStringUni(text);Need(privilege=="SeChangeNotifyPrivilege"&&Marshal.ReadInt16(text,(privilege.Length+1)*2)==0,"OAC_SERVICE_PRIVILEGES_CHANGED");}finally{Marshal.FreeHGlobal(data);}
  Status s;int n;Need(QueryServiceStatusEx(handle,0,out s,Marshal.SizeOf(typeof(Status)),out n),"OAC_STATUS_QUERY_REFUSED");Need(s.type==16&&s.state==1&&s.pid==0,"OAC_SERVICE_NOT_DRAINED");
 }
 public void Dispose(){if(handle!=IntPtr.Zero){CloseServiceHandle(handle);handle=IntPtr.Zero;}}
}
