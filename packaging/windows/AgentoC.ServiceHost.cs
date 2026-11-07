using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;

namespace AgentoC.ServiceHost
{
    // Node's net.Socket does not set a named-pipe client impersonation level.
    // The Broker verifies both the kernel-reported client PID and its
    // impersonated token, so ControlPlane uses this small mode of its already
    // installed, protected ServiceHost executable for fixed-pipe RPC.
    internal static class BrokerPipeClient
    {
        const int MaxFrameBytes = 64 * 1024;
        const string HealthPipe = "AgentoC.PrivilegedBroker.Health.v2";
        const string RequestPipe = "AgentoC.PrivilegedBroker.Request.v2";

        internal static int Run(string[] args)
        {
            if (args.Length != 2 || args[0] != "--broker-pipe"
                || (args[1] != "health" && args[1] != "request")) return 2;
            try
            {
                byte[] request = ReadStandardInput();
                if (request.Length < 5 || request.Length > MaxFrameBytes + 4
                    || BitConverter.ToUInt32(request, 0) != request.Length - 4) return 2;
                string pipeName = args[1] == "health" ? HealthPipe : RequestPipe;
                byte[] response;
                using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
                    PipeOptions.None, TokenImpersonationLevel.Impersonation))
                {
                    pipe.Connect(5000);
                    BrokerPipeServerIdentity.Verify(pipe.SafePipeHandle);
                    pipe.Write(request, 0, request.Length);
                    pipe.Flush();
                    byte[] header = ReadExactly(pipe, 4);
                    uint bodyLength = BitConverter.ToUInt32(header, 0);
                    if (bodyLength == 0 || bodyLength > MaxFrameBytes) return 2;
                    byte[] body = ReadExactly(pipe, (int)bodyLength);
                    response = new byte[header.Length + body.Length];
                    Buffer.BlockCopy(header, 0, response, 0, header.Length);
                    Buffer.BlockCopy(body, 0, response, header.Length, body.Length);
                }
                using (var output = Console.OpenStandardOutput()) output.Write(response, 0, response.Length);
                return 0;
            }
            catch { return 1; }
        }

        static byte[] ReadStandardInput()
        {
            var input = Console.OpenStandardInput();
            using (var buffer = new MemoryStream())
            {
                byte[] chunk = new byte[4096];
                int count;
                while ((count = input.Read(chunk, 0, chunk.Length)) > 0)
                {
                    if (buffer.Length + count > MaxFrameBytes + 4) throw new InvalidDataException();
                    buffer.Write(chunk, 0, count);
                }
                return buffer.ToArray();
            }
        }

        static byte[] ReadExactly(Stream input, int length)
        {
            byte[] result = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                int count = input.Read(result, offset, length - offset);
                if (count <= 0) throw new EndOfStreamException();
                offset += count;
            }
            return result;
        }
    }

    // A local process may create a same-named pipe before the service starts.
    // Bind the connected pipe to the PID currently registered by SCM for the
    // dedicated broker service before sending any request or trusting a reply.
    internal static class BrokerPipeServerIdentity
    {
        const uint ScManagerConnect = 0x0001, ServiceQueryStatus = 0x0004;
        const uint ServiceWin32OwnProcess = 0x0010, ServiceRunning = 0x0004;
        [StructLayout(LayoutKind.Sequential)]
        struct ServiceStatusProcess {
            public uint serviceType, currentState, controlsAccepted, win32ExitCode, serviceSpecificExitCode;
            public uint checkPoint, waitHint, processId, serviceFlags;
        }
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenSCManager(string machineName, string databaseName, uint desiredAccess);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr OpenService(IntPtr manager, string serviceName, uint desiredAccess);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool QueryServiceStatusEx(IntPtr service, int infoLevel, out ServiceStatusProcess status, uint bufferSize, out uint bytesNeeded);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool CloseServiceHandle(IntPtr handle);

        internal static void Verify(SafePipeHandle pipe) { VerifyService(pipe, "AgentoC-PrivilegedBroker"); }
        internal static void VerifyService(SafePipeHandle pipe, string serviceName) {
            uint serverPid;
            if (pipe == null || pipe.IsInvalid || !GetNamedPipeServerProcessId(pipe, out serverPid) || serverPid == 0)
                throw new InvalidOperationException("BROKER_PIPE_SERVER_IDENTITY_REFUSED");
            IntPtr manager = OpenSCManager(null, null, ScManagerConnect);
            if (manager == IntPtr.Zero) throw new InvalidOperationException("BROKER_PIPE_SERVER_IDENTITY_REFUSED");
            try {
                IntPtr service = OpenService(manager, serviceName, ServiceQueryStatus);
                if (service == IntPtr.Zero) throw new InvalidOperationException("BROKER_PIPE_SERVER_IDENTITY_REFUSED");
                try {
                    ServiceStatusProcess status; uint needed;
                    if (!QueryServiceStatusEx(service, 0, out status, (uint)Marshal.SizeOf(typeof(ServiceStatusProcess)), out needed)
                        || status.serviceType != ServiceWin32OwnProcess || status.currentState != ServiceRunning || status.processId != serverPid)
                        throw new InvalidOperationException("BROKER_PIPE_SERVER_IDENTITY_REFUSED");
                } finally { CloseServiceHandle(service); }
            } finally { CloseServiceHandle(manager); }
        }
    }

    // The supervisor's public endpoint is owned by the SCM service process,
    // with a protected DACL for exactly the two service identities. Node uses
    // a randomly named private backend; its PID is checked before forwarding.
    internal sealed class RunnerSupervisorPipe : IDisposable
    {
        const string PublicName = "agentoc-runner-supervisor-owner";
        const int Limit = 16384;
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes security);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafePipeHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool WaitNamedPipe(string name, uint timeout);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        readonly string backendName;
        readonly string publicName;
        readonly string supervisorSid;
        readonly string controlSid;
        readonly Func<int> expectedBackendPid;
        readonly Action onFailure;
        readonly object gate = new object();
        readonly ManualResetEvent stopped = new ManualResetEvent(false);
        readonly Semaphore slots = new Semaphore(8, 8);
        readonly List<IDisposable> active = new List<IDisposable>();
        NamedPipeServerStream pending;
        Thread thread;
        bool disposed;

        internal RunnerSupervisorPipe(string backendName, Func<int> expectedBackendPid, Action onFailure)
            : this(PublicName, backendName, expectedBackendPid, onFailure,
                new NTAccount("NT SERVICE", "AgentoC-RunnerSupervisor").Translate(typeof(SecurityIdentifier)).Value,
                new NTAccount("NT SERVICE", "AgentoC-ControlPlane").Translate(typeof(SecurityIdentifier)).Value) { }
        // The parameterized form is internal for isolated native tests; the
        // installed service always uses the fixed identities above.
        internal RunnerSupervisorPipe(string publicName, string backendName, Func<int> expectedBackendPid, Action onFailure, string supervisorSid, string controlSid) {
            if ((publicName != PublicName && !Regex.IsMatch(publicName ?? "", @"\Aagentoc-supervisor-qa-[a-f0-9]{32}\z")) || String.IsNullOrEmpty(backendName) || !Regex.IsMatch(backendName, @"\Aagentoc-supervisor-backend-[a-f0-9]{32}\z") || expectedBackendPid == null || onFailure == null)
                throw new InvalidOperationException("SHT_SUPERVISOR_PIPE_CONFIGURATION_REFUSED");
            this.publicName = publicName; this.backendName = backendName; this.expectedBackendPid = expectedBackendPid; this.onFailure = onFailure;
            this.supervisorSid = new SecurityIdentifier(supervisorSid).Value; this.controlSid = new SecurityIdentifier(controlSid).Value;
            pending = CreateListener(true);
        }
        NamedPipeServerStream CreateListener(bool first) {
            string sddl = "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;" + supervisorSid + ")(A;;0x0012019b;;;" + controlSid + ")";
            var descriptor = new RawSecurityDescriptor(sddl); var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
            IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
            try {
                Marshal.Copy(bytes, 0, memory, bytes.Length);
                var attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = memory, inherit = 0 };
                var handle = CreateNamedPipe(@"\\.\pipe\" + publicName, first ? 0x40080003u : 0x40000003u, 8, 9, Limit, Limit, 0, ref attributes);
                if (handle.IsInvalid) { int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); }
                try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); } catch { handle.Dispose(); throw; }
            } finally { Marshal.FreeHGlobal(memory); }
        }
        internal void Start() {
            thread = new Thread(Listen) { IsBackground = true, Name = "AgentoC supervisor pipe" }; thread.Start();
        }
        void Listen() {
            try {
                while (!stopped.WaitOne(0)) {
                    NamedPipeServerStream listener; lock (gate) { listener = pending; }
                    var connection = listener.BeginWaitForConnection(null, null);
                    if (WaitHandle.WaitAny(new WaitHandle[] { stopped, connection.AsyncWaitHandle }) == 0) return;
                    listener.EndWaitForConnection(connection);
                    if (WaitHandle.WaitAny(new WaitHandle[] { stopped, slots }) == 0) { listener.Dispose(); return; }
                    NamedPipeServerStream next = CreateListener(false);
                    lock (gate) {
                        if (disposed) { next.Dispose(); listener.Dispose(); slots.Release(); return; }
                        pending = next; active.Add(listener);
                    }
                    if (!ThreadPool.QueueUserWorkItem(_ => Forward(listener))) {
                        lock (gate) { active.Remove(listener); }
                        listener.Dispose(); slots.Release(); throw new InvalidOperationException("SHT_SUPERVISOR_PIPE_DISPATCH_FAILED");
                    }
                }
            } catch { if (!stopped.WaitOne(0)) { stopped.Set(); ThreadPool.QueueUserWorkItem(_ => onFailure()); } }
        }
        static byte[] ReadLine(Stream input) {
            using (var data = new MemoryStream()) {
                for (;;) { int value = input.ReadByte(); if (value < 0 || value == 13 || data.Length >= Limit) throw new InvalidDataException();
                    data.WriteByte((byte)value); if (value == 10) return data.ToArray(); }
            }
        }
        void Forward(NamedPipeServerStream peer) {
            NamedPipeClientStream backend = null;
            using (var timer = new Timer(_ => { try { peer.Dispose(); } catch {} try { if (backend != null) backend.Dispose(); } catch {} }, null, 45000, Timeout.Infinite)) {
                try {
                    byte[] request = ReadLine(peer);
                    backend = new NamedPipeClientStream(".", backendName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Impersonation);
                    backend.Connect(30000);
                    uint actual; int expected = expectedBackendPid();
                    if (expected <= 0 || !GetNamedPipeServerProcessId(backend.SafePipeHandle, out actual) || actual != (uint)expected)
                        throw new InvalidOperationException("SHT_SUPERVISOR_BACKEND_IDENTITY_REFUSED");
                    backend.Write(request, 0, request.Length); backend.Flush();
                    byte[] response = ReadLine(backend); peer.Write(response, 0, response.Length); peer.Flush();
                } catch { }
                finally { if (backend != null) backend.Dispose(); peer.Dispose(); lock (gate) { active.Remove(peer); } slots.Release(); }
            }
        }
        internal static int Client(string[] args) {
            if (args.Length != 1) return 2;
            return ClientCore(PublicName, Console.OpenStandardInput(), Console.OpenStandardOutput(),
                pipe => BrokerPipeServerIdentity.VerifyService(pipe, "AgentoC-RunnerSupervisor"));
        }
        internal static int ClientCore(string name, Stream input, Stream output, Action<SafePipeHandle> verify) {
            try {
                byte[] request = ReadLine(input);
                string path = @"\\.\pipe\" + name;
                var deadline = Stopwatch.StartNew(); SafePipeHandle connected = null;
                while (deadline.ElapsedMilliseconds < 30000) {
                    uint remaining = (uint)Math.Max(1, 30000 - deadline.ElapsedMilliseconds);
                    if (!WaitNamedPipe(path, remaining)) {
                        int code = Marshal.GetLastWin32Error(); if (code != 2 && code != 231) return 1;
                        Thread.Sleep(25); continue;
                    }
                    var candidate = CreateFile(path, 0x0012019b, 0, IntPtr.Zero, 3, 0x00120000, IntPtr.Zero);
                    if (!candidate.IsInvalid) { connected = candidate; break; }
                    int failure = Marshal.GetLastWin32Error(); candidate.Dispose();
                    if (failure != 2 && failure != 231) return 1;
                    Thread.Sleep(25);
                }
                if (connected == null) return 1;
                using (var handle = connected) {
                    using (var pipe = new NamedPipeClientStream(PipeDirection.InOut, false, true, handle)) {
                        verify(pipe.SafePipeHandle);
                        pipe.Write(request, 0, request.Length); pipe.Flush();
                        byte[] response = ReadLine(pipe); output.Write(response, 0, response.Length);
                    }
                }
                return 0;
            } catch { return 1; }
        }
        public void Dispose() {
            lock (gate) { if (disposed) return; disposed = true; stopped.Set(); foreach (var item in active.ToArray()) try { item.Dispose(); } catch {} }
            bool joined = thread == null || thread.Join(5000);
            lock (gate) { if (pending != null) pending.Dispose(); }
            if (!joined) throw new InvalidOperationException("SHT_SUPERVISOR_PIPE_STOP_TIMEOUT");
        }
    }

    // A directory handle alone does not block metadata-only reparse IOCTLs.
    // Retain an immediate child too: NTFS refuses a reparse point on a nonempty
    // directory, and neither handle permits DELETE sharing. Never inherit them.
    internal static class ServiceDirectoryPin
    {
        [StructLayout(LayoutKind.Sequential)] struct Info {public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint size,uint flags);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder name,uint size,out uint serial,out uint maximum,out uint flags,StringBuilder filesystem,uint fsSize);
        internal static SafeFileHandle Directory(string path) {
            var handle=CreateFile(path,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            try {Verify(handle,path);return handle;}catch{handle.Dispose();throw;}
        }
        static void Verify(SafeFileHandle handle,string path) {
            Info info;var final=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(handle,final,(uint)final.Capacity,0);
            if(handle.IsInvalid||!GetFileInformationByHandle(handle,out info)||(info.attributes&0x400)!=0||(info.attributes&16)==0||length==0||length>=final.Capacity
                ||!String.Equals(final.ToString(),@"\\?\"+Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("SHT_DIRECTORY_IDENTITY_REFUSED");
        }
        internal static void VerifyFile(SafeFileHandle handle,string path) {
            Info info;var final=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(handle,final,(uint)final.Capacity,0);
            if(handle.IsInvalid||!GetFileInformationByHandle(handle,out info)||(info.attributes&0x410)!=0||info.links!=1||length==0||length>=final.Capacity
                ||!String.Equals(final.ToString(),@"\\?\"+Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("SHT_FILE_IDENTITY_REFUSED");
        }
        internal static string FileIdentity(SafeFileHandle handle,string path) {
            VerifyFile(handle,path);Info info;
            if(!GetFileInformationByHandle(handle,out info))throw new InvalidOperationException("SHT_FILE_IDENTITY_REFUSED");
            return info.volume.ToString("x8")+info.indexHigh.ToString("x8")+info.indexLow.ToString("x8");
        }
        internal static SafeFileHandle[] NonemptyDirectory(string path,string child) {
            path=Path.GetFullPath(path);child=Path.GetFullPath(child);
            if(!String.Equals(Path.GetDirectoryName(child),path.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("SHT_ANCESTOR_WITNESS_REFUSED");
            var parent=Directory(path);SafeFileHandle witness=null;
            try {
                witness=Directory(child);Verify(parent,path);
                uint serial,maximum,flags;var fs=new StringBuilder(32);
                if(!GetVolumeInformationByHandleW(parent,null,0,out serial,out maximum,out flags,fs,32)||fs.ToString()!="NTFS")throw new InvalidOperationException("SHT_ANCESTOR_WITNESS_REFUSED");
                return new[]{parent,witness};
            }catch{if(witness!=null)witness.Dispose();parent.Dispose();throw;}
        }
        // The host keeps these until OS process exit, including stop/startup
        // failure. They are not released on an unconfirmed child shutdown.
        internal static readonly List<SafeFileHandle> Lifetime=new List<SafeFileHandle>();
    }
    // The process token itself is reduced before any business IO or child.
    // No impersonation, alternate token, SYSTEM fallback or environment claim.
    internal static class ServiceToken
    {
        const uint KernelObject=6,DaclSecurityInformation=4,ProcessSynchronize=0x00100000,GrantAccess=1;
        const int TrusteeIsSid=0,TrusteeTypeUnknown=0;
        [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr sid; public uint attributes; }
        [StructLayout(LayoutKind.Sequential)] struct Trustee { public IntPtr multipleTrustee; public int multipleTrusteeOperation, form, type; public IntPtr name; }
        [StructLayout(LayoutKind.Sequential)] struct ExplicitAccess { public uint permissions; public int mode; public uint inheritance; public Trustee trustee; }
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,uint objectType,uint securityInfo,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
        [DllImport("advapi32.dll",EntryPoint="SetEntriesInAclW",SetLastError=true)] static extern uint SetEntriesInAcl(uint count,ref ExplicitAccess entries,IntPtr oldAcl,out IntPtr newAcl);
        [DllImport("advapi32.dll",SetLastError=true)] static extern uint SetSecurityInfo(IntPtr handle,uint objectType,uint securityInfo,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid, out int session);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenThreadToken(IntPtr thread, uint access, bool self, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, int size);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, IntPtr state, int size, IntPtr previous, IntPtr returned);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeName(string system, IntPtr luid, StringBuilder name, ref int size);
        static void Need(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
        static void Check(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
        static void GrantSystemWaitOnServiceProcess()
        {
            IntPtr owner,group,dacl,sacl,descriptor=IntPtr.Zero,newDacl=IntPtr.Zero,sidMemory=IntPtr.Zero;
            uint error=GetSecurityInfo(GetCurrentProcess(),KernelObject,DaclSecurityInformation,out owner,out group,out dacl,out sacl,out descriptor);
            if(error!=0){if(descriptor!=IntPtr.Zero)LocalFree(descriptor);throw new InvalidOperationException("SHT_PROCESS_DACL_QUERY_FAILED");}
            try {
                var sid=new SecurityIdentifier("S-1-5-18");var bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);
                sidMemory=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,sidMemory,bytes.Length);
                var entry=new ExplicitAccess {permissions=ProcessSynchronize,mode=(int)GrantAccess,inheritance=0,trustee=new Trustee {multipleTrustee=IntPtr.Zero,multipleTrusteeOperation=0,form=TrusteeIsSid,type=TrusteeTypeUnknown,name=sidMemory}};
                error=SetEntriesInAcl(1,ref entry,dacl,out newDacl);Need(error==0,"SHT_PROCESS_DACL_PREPARE_FAILED");
                error=SetSecurityInfo(GetCurrentProcess(),KernelObject,DaclSecurityInformation,IntPtr.Zero,IntPtr.Zero,newDacl,IntPtr.Zero);Need(error==0,"SHT_PROCESS_DACL_APPLY_FAILED");
            } finally {
                if(sidMemory!=IntPtr.Zero)Marshal.FreeHGlobal(sidMemory);
                if(newDacl!=IntPtr.Zero)LocalFree(newDacl);
                if(descriptor!=IntPtr.Zero)LocalFree(descriptor);
            }
        }
        static IntPtr Data(IntPtr token, int kind)
        {
            int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
            Need(size>0 && size<=65536,"SHT_TOKEN_SIZE_INVALID");
            var data=Marshal.AllocHGlobal(size);
            if (!GetTokenInformation(token,kind,data,size,out size)) { Marshal.FreeHGlobal(data); throw new InvalidOperationException("SHT_TOKEN_QUERY_FAILED"); }
            return data;
        }
        static string Privilege(IntPtr luid)
        {
            int size=256; var name=new StringBuilder(size);
            Check(LookupPrivilegeName(null,luid,name,ref size),"SHT_PRIVILEGE_QUERY_FAILED"); return name.ToString();
        }
        static void NoImpersonation()
        {
            IntPtr token; bool found=OpenThreadToken(GetCurrentThread(),8,true,out token); int error=Marshal.GetLastWin32Error();
            if (found) CloseHandle(token);
            Need(!found && error==1008,"SHT_THREAD_TOKEN_REFUSED");
        }
        static void Verify(IntPtr token, string expectedSid, bool reduced, uint processId)
        {
            IntPtr data=Data(token,1);
            try { Need(new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value==expectedSid,"SHT_SERVICE_ACCOUNT_REFUSED"); } finally { Marshal.FreeHGlobal(data); }
            int session; Check(ProcessIdToSessionId(processId,out session),"SHT_SESSION_QUERY_FAILED");
            Need(session==0,"SHT_SERVICE_SESSION_REQUIRED");
            data=Data(token,12); try { Need(Marshal.ReadInt32(data)==0,"SHT_TOKEN_SESSION_REFUSED"); } finally { Marshal.FreeHGlobal(data); }
            data=Data(token,2);
            try {
                int count=Marshal.ReadInt32(data), offset=IntPtr.Size==8?8:4, stride=IntPtr.Size==8?16:8;
                Need(count>=0 && count<=1024,"SHT_GROUP_COUNT_INVALID");
                for(int i=0;i<count;i++) {
                    var group=IntPtr.Add(data,offset+i*stride); int attributes=Marshal.ReadInt32(group,IntPtr.Size);
                    Need((attributes&4)==0 || (attributes&16)!=0 || new SecurityIdentifier(Marshal.ReadIntPtr(group)).Value!="S-1-5-32-544","SHT_ADMINISTRATOR_REFUSED");
                }
            } finally { Marshal.FreeHGlobal(data); }
            if (!reduced) return;
            data=Data(token,20); try { Need(Marshal.ReadInt32(data)==0,"SHT_ELEVATION_REFUSED"); } finally { Marshal.FreeHGlobal(data); }
            data=Data(token,25); try { Need(new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value=="S-1-16-8192","SHT_MEDIUM_INTEGRITY_REQUIRED"); } finally { Marshal.FreeHGlobal(data); }
            data=Data(token,3);
            try {
                int count=Marshal.ReadInt32(data); Need(count>=0 && count<=256,"SHT_PRIVILEGE_COUNT_INVALID");
                for(int i=0;i<count;i++) Need(Privilege(IntPtr.Add(data,4+i*12))=="SeChangeNotifyPrivilege","SHT_PRIVILEGE_REMAINED");
            } finally { Marshal.FreeHGlobal(data); }
            NoImpersonation();
        }
        internal static void Reduce(string serviceName)
        {
            Need(serviceName=="AgentoC-ControlPlane" || serviceName=="AgentoC-RunnerSupervisor","SHT_SERVICE_NAME_REFUSED");
            string expectedSid=new NTAccount("NT SERVICE",serviceName).Translate(typeof(SecurityIdentifier)).Value;
            Need(expectedSid.StartsWith("S-1-5-80-",StringComparison.Ordinal),"SHT_SERVICE_SID_INVALID");
            NoImpersonation(); IntPtr token;
            Check(OpenProcessToken(GetCurrentProcess(),8|32|128,out token),"SHT_TOKEN_OPEN_FAILED");
            try {
                Verify(token,expectedSid,false,(uint)Process.GetCurrentProcess().Id);
                // The MSI activation caller needs only to wait for this exact
                // service process to exit. Grant LocalSystem that one right;
                // no query, memory, token, or termination access is added.
                GrantSystemWaitOnServiceProcess();
                // SE_PRIVILEGE_REMOVED is irreversible; disabling would allow
                // a later Node process to re-enable inherited privileges.
                IntPtr data=Data(token,3);
                try {
                    int count=Marshal.ReadInt32(data); Need(count>=0 && count<=256,"SHT_PRIVILEGE_COUNT_INVALID");
                    var remove=new List<byte[]>();
                    for(int i=0;i<count;i++) {
                        var luid=IntPtr.Add(data,4+i*12); if(Privilege(luid)=="SeChangeNotifyPrivilege") continue;
                        var entry=new byte[12]; Marshal.Copy(luid,entry,0,8); Array.Copy(BitConverter.GetBytes(4),0,entry,8,4); remove.Add(entry);
                    }
                    if(remove.Count>0) {
                        IntPtr state=Marshal.AllocHGlobal(4+12*remove.Count);
                        try {
                            Marshal.WriteInt32(state,remove.Count);
                            for(int i=0;i<remove.Count;i++) Marshal.Copy(remove[i],0,IntPtr.Add(state,4+12*i),12);
                            Check(AdjustTokenPrivileges(token,false,state,0,IntPtr.Zero,IntPtr.Zero),"SHT_PRIVILEGE_REMOVAL_FAILED");
                            Need(Marshal.GetLastWin32Error()!=1300,"SHT_PRIVILEGE_REMOVAL_INCOMPLETE");
                        } finally { Marshal.FreeHGlobal(state); }
                    }
                } finally { Marshal.FreeHGlobal(data); }
                var sid=new SecurityIdentifier("S-1-16-8192"); var bytes=new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0);
                IntPtr label=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAttributes))+bytes.Length);
                try {
                    IntPtr labelSid=IntPtr.Add(label,Marshal.SizeOf(typeof(SidAttributes))); Marshal.Copy(bytes,0,labelSid,bytes.Length);
                    Marshal.StructureToPtr(new SidAttributes {sid=labelSid,attributes=32},label,false);
                    Check(SetTokenInformation(token,25,label,Marshal.SizeOf(typeof(SidAttributes))+bytes.Length),"SHT_INTEGRITY_REDUCTION_FAILED");
                } finally { Marshal.FreeHGlobal(label); }
                Verify(token,expectedSid,true,(uint)Process.GetCurrentProcess().Id);
            } finally { CloseHandle(token); }
        }
        internal static void VerifyChild(Process child,string serviceName) {
            IntPtr token;Check(OpenProcessToken(child.Handle,8,out token),"SHT_CHILD_TOKEN_OPEN_FAILED");
            try {Verify(token,new NTAccount("NT SERVICE",serviceName).Translate(typeof(SecurityIdentifier)).Value,true,(uint)child.Id);}
            finally {CloseHandle(token);}
        }
    }

    // Metadata-only recovery for this host's own retained child. It never
    // adopts a marker from a previous service process, reads identity secrets,
    // grants authority, or treats a missing/reused PID as proof of ownership.
    internal sealed class OwnedChildMarker : IDisposable
    {
        internal const int ProtocolVersion = 1;
        [StructLayout(LayoutKind.Sequential)] struct RenameHeader {public uint replace;public IntPtr root;public uint bytes;public ushort first;}
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,IntPtr data,uint size);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WaitNamedPipe(string name,uint timeout);
        readonly Process process;readonly IntPtr processHandle;readonly int pid;
        readonly string path,instance,endpoint,token;readonly object gate=new object();
        readonly List<IDisposable> pins=new List<IDisposable>();
        FileStream captured;byte[] original;string identity;Timer timer;bool disposed;
        internal bool Captured {get {lock(gate)return captured!=null;}}
        internal static Dictionary<string,object> FlatJson(byte[] bytes,string[] keys) {
            Need(bytes.Length>0&&bytes.Length<=8192,"SHT_OWNERSHIP_METADATA_INVALID");
            string text=new UTF8Encoding(false,true).GetString(bytes);
            // Framework assembly already used by the installed bridge. Resolve
            // here so legacy standalone host compilation needs no new reference.
            var type=Type.GetType("System.Web.Script.Serialization.JavaScriptSerializer, System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",true);
            var result=type.GetMethod("DeserializeObject").Invoke(Activator.CreateInstance(type),new object[]{text}) as Dictionary<string,object>;
            Need(result!=null&&result.Count==keys.Length,"SHT_OWNERSHIP_METADATA_INVALID");
            Need(Regex.Matches(text,"(?<!\\\\)\"(?:\\\\.|[^\"\\\\])*\"\\s*:").Count==keys.Length,"SHT_OWNERSHIP_METADATA_INVALID");
            foreach(string key in keys)Need(result.ContainsKey(key)&&Regex.Matches(text,"\""+key+"\"\\s*:").Count==1,"SHT_OWNERSHIP_METADATA_INVALID");
            return result;
        }
        internal static string Endpoint(string root,string instance) {
            using(var hash=SHA256.Create()) {
                string a=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).TrimEnd('\\').Normalize().ToLowerInvariant()))).Replace("-","").ToLowerInvariant().Substring(0,24);
                string b=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(instance.Normalize()))).Replace("-","").ToLowerInvariant().Substring(0,24);
                return @"\\.\pipe\agentoc-"+a+"-"+b;
            }
        }
        static void Need(bool condition,string code){if(!condition)throw new InvalidOperationException(code);}
        static byte[] Read(FileStream file) {
            Need(file.Length>0&&file.Length<=8192,"SHT_OWNERSHIP_METADATA_INVALID");file.Position=0;var bytes=new byte[file.Length];int offset=0;
            while(offset<bytes.Length){int n=file.Read(bytes,offset,bytes.Length-offset);Need(n>0,"SHT_OWNERSHIP_METADATA_INVALID");offset+=n;}
            return bytes;
        }
        static bool Equal(byte[] a,byte[] b){if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
        static void FileAcl(string path) {
            var allowed=new HashSet<string>(new[]{WindowsIdentity.GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"});
            var acl=File.GetAccessControl(path);Need(allowed.Contains(acl.GetOwner(typeof(SecurityIdentifier)).Value),"SHT_OWNERSHIP_FILE_OWNER");
            foreach(FileSystemAccessRule ace in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(ace.AccessControlType==AccessControlType.Allow&&(ace.PropagationFlags&PropagationFlags.InheritOnly)==0&&!allowed.Contains(ace.IdentityReference.Value))Need(((long)ace.FileSystemRights&0x500d0156L)==0,"SHT_OWNERSHIP_FILE_WRITABLE");
        }
        internal OwnedChildMarker(Process child,string runtime,string instanceId,string nonce) {
            Need(child!=null&&Regex.IsMatch(instanceId,@"\Ainst_[a-f0-9]{32}\z")&&Regex.IsMatch(nonce,@"\Asvc_[a-f0-9]{32}\z"),"SHT_OWNERSHIP_BINDING_INVALID");
            process=child;processHandle=child.Handle;pid=child.Id;instance=instanceId;token=nonce;
            path=Path.Combine(runtime,"instance-ownership.json");endpoint=Endpoint(Path.GetDirectoryName(runtime),instance);
            try {
                // Retained parents + a locked, delete-on-close immediate child
                // keep the runtime directory nonempty against reparse IOCTLs.
                for(string p=runtime;p!=null;p=Path.GetDirectoryName(p))pins.Add(ServiceDirectoryPin.Directory(p));
                var witness=new FileStream(Path.Combine(runtime,".owned-child-"+nonce+".lease"),FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read,4096,FileOptions.DeleteOnClose);
                pins.Add(witness);ServiceDirectoryPin.VerifyFile(witness.SafeFileHandle,Path.Combine(runtime,".owned-child-"+nonce+".lease"));
                using(var check=ServiceDirectoryPin.Directory(runtime)){}
                timer=new Timer(s=>{try{TryCapture();}catch{}},null,0,100);
            }catch{Dispose();throw;}
        }
        // Pin while the actual retained child is still alive. A later file at
        // the same path, even with identical JSON, never inherits this witness.
        internal bool TryCapture() {
            lock(gate) {
                if(disposed||captured!=null)return captured!=null;
                if(WaitForSingleObject(processHandle,0)!=258)return false;
                FileStream file=null;
                try {
                    file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
                    string id=ServiceDirectoryPin.FileIdentity(file.SafeFileHandle,path);FileAcl(path);byte[] bytes=Read(file);
                    var value=FlatJson(bytes,new[]{"version","instanceId","endpointName","pid","token","startedAt"});DateTime started;
                    Need(value["version"] is int&&(int)value["version"]==1&&value["instanceId"] as string==instance&&value["endpointName"] as string==endpoint&&value["pid"] is int&&(int)value["pid"]==pid&&value["token"] as string==token&&value["startedAt"] is string&&DateTime.TryParseExact((string)value["startedAt"],"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.AssumeUniversal|System.Globalization.DateTimeStyles.AdjustToUniversal,out started),"SHT_OWNERSHIP_BINDING_INVALID");
                    Need(WaitForSingleObject(processHandle,0)==258,"SHT_OWNERSHIP_CAPTURE_TOO_LATE");
                    identity=id;original=bytes;captured=file;file=null;return true;
                }catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}
                finally{if(file!=null)file.Dispose();}
            }
        }
        internal string ArchiveAfterExit(Func<bool> cancelled=null) {
            lock(gate) {
                Need(!disposed,"SHT_OWNERSHIP_LEASE_CLOSED");Need(captured!=null,"SHT_OWNERSHIP_NOT_WITNESSED");Need(WaitForSingleObject(processHandle,0)==0,"SHT_OWNERSHIP_CHILD_ALIVE");
                Need(cancelled==null||!cancelled(),"SHT_OWNERSHIP_RECOVERY_CANCELLED");
                if(WaitNamedPipe(endpoint,1))throw new InvalidOperationException("SHT_OWNERSHIP_ENDPOINT_PRESENT");
                Need(Marshal.GetLastWin32Error()==2,"SHT_OWNERSHIP_ENDPOINT_UNVERIFIED");
                using(var handle=CreateFile(path,0x80010080u,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
                    if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();if(error==2)return "already-released";throw new InvalidOperationException("SHT_OWNERSHIP_FILE_REFUSED");}
                    Need(ServiceDirectoryPin.FileIdentity(handle,path)==identity,"SHT_OWNERSHIP_FILE_REPLACED");
                    FileAcl(path);
                    using(var file=new FileStream(handle,FileAccess.Read)) {
                        Need(Equal(Read(file),original),"SHT_OWNERSHIP_FILE_CHANGED");
                        string archive=Path.Combine(Path.GetDirectoryName(path),"instance-ownership.exited-"+token.Substring(4)+".json");
                        byte[] name=Encoding.Unicode.GetBytes(archive);int offset=(int)Marshal.OffsetOf(typeof(RenameHeader),"first"),size=offset+name.Length+2;IntPtr data=Marshal.AllocHGlobal(size);
                        try {
                            for(int i=0;i<size;i++)Marshal.WriteByte(data,i,0);
                            Marshal.WriteInt32(data,(int)Marshal.OffsetOf(typeof(RenameHeader),"bytes"),name.Length);Marshal.Copy(name,0,IntPtr.Add(data,offset),name.Length);
                            Need(cancelled==null||!cancelled(),"SHT_OWNERSHIP_RECOVERY_CANCELLED");
                            Need(SetFileInformationByHandle(handle,3,data,(uint)size),"SHT_OWNERSHIP_ARCHIVE_REFUSED");
                            Need(ServiceDirectoryPin.FileIdentity(handle,archive)==identity,"SHT_OWNERSHIP_ARCHIVE_UNCONFIRMED");return "archived";
                        }finally{Marshal.FreeHGlobal(data);}
                    }
                }
            }
        }
        public void Dispose(){lock(gate){if(disposed)return;disposed=true;if(timer!=null)timer.Dispose();if(captured!=null)captured.Dispose();for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}}
    }

    public sealed class AgentoCService : ServiceBase
    {
        private static string ProgramDataPath() {
            var value=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if(String.IsNullOrWhiteSpace(value)||!Path.IsPathRooted(value))throw new InvalidOperationException("SHT_PROGRAMDATA_UNAVAILABLE");
            return Path.GetFullPath(value).TrimEnd('\\');
        }
        private static string OwnerInstancePath() { return Path.Combine(ProgramDataPath(),@"AgentoC\instances\owner"); }
        private readonly string role;
        private readonly string nodePath;
        private readonly string scriptPath;
        private readonly string workingDirectory;
        private readonly string configDirectory;
        private readonly string instanceRoot;
        private readonly string productRoot;
        private readonly string authSessionSecretPath;
        private readonly string stopFilePath;
        private string childLogPath;
        private Process child;
        private readonly string supervisorBackendName = "agentoc-supervisor-backend-" + Guid.NewGuid().ToString("N");
        private RunnerSupervisorPipe supervisorPipe;
        private volatile bool stopping;
        private readonly object childGate=new object();
        private readonly ManualResetEvent recoveryStop=new ManualResetEvent(false);
        private readonly Stopwatch recoveryWindow=new Stopwatch();
        private int recoveryAttempts;
        private OwnedChildMarker childOwnership;
        private readonly List<IDisposable> recoveryPolicyPins=new List<IDisposable>();
        private string recoveryInstance;
        private Action revalidateForRecovery;

        public AgentoCService(string serviceName, string role, string nodePath, string scriptPath,
            string workingDirectory, string configDirectory, string instanceRoot = null, string productRoot = null)
        {
            if (role != "control" && role != "supervisor")
                throw new ArgumentException("Unsupported AgentoC service role.", "role");
            ServiceName = serviceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
            this.role = role;
            this.nodePath = nodePath;
            this.scriptPath = scriptPath;
            this.workingDirectory = workingDirectory;
            this.configDirectory = configDirectory;
            this.instanceRoot = instanceRoot ?? Path.GetDirectoryName(configDirectory);
            this.productRoot = Path.GetFullPath(productRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "AgentoC")).TrimEnd('\\');
            revalidateForRecovery=ValidateInstalledLayout;
            authSessionSecretPath = Path.Combine(configDirectory, "auth-session-secret");
            stopFilePath = Path.GetFullPath(Path.Combine(configDirectory, "..", "runtime", "service-stop-" + role + ".request"));
        }

        protected override void OnStart(string[] args)
        {
            try {
            // No directory, credential read or child before actual token gates.
            ServiceToken.Reduce(ServiceName);
            if(args.Length!=0) {
                if(args.Length!=1 || args[0]!="--initialize-owner-identity" || role!="control")throw new InvalidOperationException("SHT_START_ARGUMENTS_REFUSED");
                InitializeOwnerIdentity();return;
            }
            ValidateInstalledLayout();
            stopping = false;
            recoveryStop.Reset();recoveryAttempts=0;recoveryWindow.Restart();
            Directory.CreateDirectory(Path.GetDirectoryName(stopFilePath));
            try { File.Delete(stopFilePath); } catch { }
            Directory.CreateDirectory(configDirectory);
            childLogPath = Path.Combine(configDirectory, "logs", "service-" + role + ".log");
            Directory.CreateDirectory(Path.GetDirectoryName(childLogPath));
            if(role=="control") {
                var policy=OwnedChildMarker.FlatJson(ReadAdministrativeInput(Path.Combine(instanceRoot,@"security\owner-bootstrap-install.json"),recoveryPolicyPins,8192),new[]{"version","instanceId","controlSid","executorSid","ownerSid","port"});
                if(!(policy["version"] is int)||(int)policy["version"]!=1||!(policy["port"] is int)||(int)policy["port"]!=7690||policy["controlSid"] as string!=WindowsIdentity.GetCurrent().User.Value||!(policy["instanceId"] is string)||!Regex.IsMatch((string)policy["instanceId"],@"\Ainst_[a-f0-9]{32}\z"))throw new InvalidOperationException("SHT_OWNERSHIP_POLICY_INVALID");
                recoveryInstance=(string)policy["instanceId"];
            }
            if(role=="supervisor") supervisorPipe=new RunnerSupervisorPipe(supervisorBackendName, () => {
                try { var current=child; return current!=null && !current.HasExited ? current.Id : 0; } catch { return 0; }
            }, () => { ExitCode=1; try { Stop(); } catch {} });
            lock(childGate){StartChild();}
            if(supervisorPipe!=null)supervisorPipe.Start();
            WriteEvent(1000, EventLogEntryType.Information, "AgentoC " + role + " service started.");
            } catch(Exception error) {
                if(supervisorPipe!=null){supervisorPipe.Dispose();supervisorPipe=null;}
                if(child!=null){try{StopChild();}catch{}}
                ExitCode=1064; // ERROR_EXCEPTION_IN_SERVICE; never report a clean stop on failed startup.
                var code=error is InvalidOperationException && error.Message.StartsWith("SHT_",StringComparison.Ordinal)?error.Message:"SHT_STARTUP_FAILED";
                WriteEvent(1004,EventLogEntryType.Error,"AgentoC "+role+" startup refused: "+code);
                throw;
            }
        }

        // Caller holds childGate. The nonce only correlates a marker with the
        // retained child; it carries no Owner, broker or installation authority.
        private void StartChild() {
            var info=BuildChildStartInfo();string nonce="svc_"+Guid.NewGuid().ToString("N");
            if(role=="control")info.EnvironmentVariables["AGENTOC_SERVICE_OWNERSHIP_TOKEN"]=nonce;
            child=new Process {StartInfo=info,EnableRaisingEvents=true};
            child.Exited+=ChildExited;child.OutputDataReceived+=ChildOutputReceived;child.ErrorDataReceived+=ChildOutputReceived;
            bool started=false;
            try {
                if(!child.Start())throw new InvalidOperationException("SHT_CHILD_START_FAILED");started=true;
                if(role=="control")childOwnership=new OwnedChildMarker(child,Path.GetDirectoryName(stopFilePath),recoveryInstance,nonce);
                child.BeginOutputReadLine();child.BeginErrorReadLine();
            }catch {
                if(childOwnership!=null){childOwnership.Dispose();childOwnership=null;}
                if(started){try{StopChild();}catch{}}else{child.Dispose();child=null;}
                throw;
            }
        }

        // Also used by the compiled ordinary-user launch regression. Keeping
        // environment construction here exercises the same path as OnStart.
        internal ProcessStartInfo BuildChildStartInfo()
        {
            return BuildChildStartInfoCore(false);
        }
        private ProcessStartInfo BuildChildStartInfoCore(bool initializing)
        {
            var info = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = Quote(scriptPath),
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            if (role == "supervisor" || role == "control")
            {
                // Never inherit the installer's/control process's credentials.
                // Keep general OS tool paths; built-in Harness discovery uses
                // only the explicitly owned prefix below.
                info.EnvironmentVariables.Clear();
                foreach (var name in new[] { "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH", "PATHEXT",
                    "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PROCESSOR_ARCHITECTURE",
                    "NUMBER_OF_PROCESSORS", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP" })
                {
                    var value = Environment.GetEnvironmentVariable(name);
                    if (!String.IsNullOrEmpty(value)) info.EnvironmentVariables[name] = value;
                }
                CopyPublicProxyEnvironment(info);
            }
            // An administrative service environment may explicitly enable
            // private temporary-control QA. Never send this feature switch to
            // the executor or identity initializer, or inherit arbitrary flags.
            if (role == "control" && !initializing
                && Environment.GetEnvironmentVariable("AGENTOC_TEMPORARY_PAIRING_ENABLED") == "1")
                info.EnvironmentVariables["AGENTOC_TEMPORARY_PAIRING_ENABLED"] = "1";
            info.EnvironmentVariables["AGENTOC_WINDOWS_SERVICE_ROLE"] = role;
            info.EnvironmentVariables["AGENTOC_WINDOWS_SERVICE_MODE"] = "1";
            // The bundled Node 24 runtime otherwise ignores configured system
            // proxies for fetch(). Whisper's pinned runtime/model downloads use
            // only those explicit proxy settings and verify fixed SHA-256 values.
            info.EnvironmentVariables["NODE_USE_ENV_PROXY"] = "1";
            // Do not trust an inherited ProgramData override for the fixed
            // owner layout; this value comes from the Windows known folder.
            info.EnvironmentVariables["ProgramData"] = ProgramDataPath();
            info.EnvironmentVariables["AGENTOC_INSTALL_ROOT"] = productRoot;
            info.EnvironmentVariables["AGENTOC_CONFIG_DIR"] = configDirectory;
            info.EnvironmentVariables["AGENTOC_INSTANCE_ROOT"] = instanceRoot;
            // Managed supervisor config is private but spool/provider roots
            // remain on the same explicitly pinned instance as the controller.
            if (String.Equals(instanceRoot,OwnerInstancePath(),StringComparison.OrdinalIgnoreCase))
            {
                var home=role=="control"?Path.Combine(instanceRoot,"home"):Path.Combine(instanceRoot,"executor","home");
                foreach(var key in new[] {"HOME","USERPROFILE"}) info.EnvironmentVariables[key]=home;
                info.EnvironmentVariables["APPDATA"]=Path.Combine(home,"AppData","Roaming");
                info.EnvironmentVariables["LOCALAPPDATA"]=Path.Combine(home,"AppData","Local");
                info.EnvironmentVariables["TEMP"]=info.EnvironmentVariables["TMP"]=role=="control"?Path.Combine(instanceRoot,"tmp"):Path.Combine(instanceRoot,"executor","tmp");
            }
            // The supervisor validates the Provider-homes root independently
            // of the control plane's Windows path resolver.  Keep both
            // services on the same instance-scoped paths so a production
            // install can launch runners without an operator-created env var.
            info.EnvironmentVariables["AGENTOC_RUN_SPOOL_DIR"] = Path.Combine(instanceRoot, "data", "chat-runs");
            info.EnvironmentVariables["AGENTOC_PROVIDER_HOMES_DIR"] = Path.Combine(instanceRoot, "provider-homes");
            if (role == "control" && !initializing) info.EnvironmentVariables["AGENTOC_AUTH_SESSION_SECRET"] = EnsureAuthSessionSecret();
            info.EnvironmentVariables["AGENTOC_HARNESS_ROOT"] = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "AgentoC", "harnesses");
            // Optional bundled package manager; never adopt a global Harness.
            var bundledNpm = Path.Combine(workingDirectory, "npm.cmd");
            if (File.Exists(bundledNpm))
            {
                info.EnvironmentVariables["AGENTOC_NPM_COMMAND"] = bundledNpm;
            }
            info.EnvironmentVariables["AGENTOC_RUNNER_SUPERVISOR_SOCKET"] = "\\\\.\\pipe\\" + (role=="supervisor" ? supervisorBackendName : "agentoc-runner-supervisor-owner");
            info.EnvironmentVariables["AGENTOC_RUNNER_SUPERVISOR_REQUIRED"] = "1";
            info.EnvironmentVariables["AGENTOC_WINDOWS_SERVICE_STOP_FILE"] = stopFilePath;
            return info;
        }

        private void ValidateInstalledLayout()
        {
            ValidateLayout(false);
        }
        private void ValidateLayout(bool initializing)
        {
            var product=Path.Combine(productRoot,"payload");
            var root=OwnerInstancePath();
            var expectedConfig=role=="control"?Path.Combine(root,"config"):Path.Combine(root,"executor","config");
            var expectedScript=Path.Combine(product,role=="control"?"chat-server.mjs":@"chat\runner-supervisor-daemon.mjs");
            foreach(var pair in new[] {new[]{instanceRoot,root},new[]{configDirectory,expectedConfig},new[]{workingDirectory,product},new[]{nodePath,Path.Combine(product,"node.exe")},new[]{scriptPath,expectedScript}})
                if(!String.Equals(Path.GetFullPath(pair[0]),pair[1],StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("SHT_INSTALLED_PATH_REFUSED");
            for(string path=productRoot;path!=null;path=Path.GetDirectoryName(path)) ServiceDirectoryPin.Lifetime.Add(ServiceDirectoryPin.Directory(path));
            foreach(var marker in new[] {Path.Combine(productRoot,"owner-activation.prepare-lock"),Path.Combine(productRoot,"owner-services.prepare-lock"),Path.Combine(productRoot,"owner-data.prepare-lock"),Path.Combine(productRoot,"owner-msi.prepare-lock"),Path.Combine(root,"owner-policy.install-lock")}) {
                try { File.GetAttributes(marker); throw new InvalidOperationException("SHT_INSTALLATION_INCOMPLETE"); }
                catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
            }
            // A prepared MSI is not an activated installation. Changing SCM
            // start mode alone must not create credentials or launch Node.
            if(!initializing) {
                foreach(var marker in new[]{Path.Combine(productRoot,"owner-identity.initialize-lock"),Path.Combine(productRoot,"owner-msi.prepared.json"),Path.Combine(productRoot,"owner-policy.prepare-lock"),Path.Combine(productRoot,"owner-msi.policy.json")}) {
                    try {File.GetAttributes(marker);throw new InvalidOperationException("SHT_PREPARED_INSTALLATION_INACTIVE");}
                    catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
                }
            }
            string sid=WindowsIdentity.GetCurrent().User.Value;
            CheckDataDirectory(configDirectory,sid,true);
            CheckDataDirectory(Path.GetDirectoryName(stopFilePath),sid,false);
            CheckDataDirectory(role=="control"?Path.Combine(root,"home"):Path.Combine(root,"executor","home"),sid,true);
            CheckDataDirectory(role=="control"?Path.Combine(root,"tmp"):Path.Combine(root,"executor","tmp"),sid,true);
        }

        // This one-shot path never starts the normal entry, creates an auth
        // secret, or grants Owner authority. Both administrative markers stay
        // pinned; a crash keeps the installation inactive for explicit repair.
        private void InitializeOwnerIdentity() {
            ValidateLayout(true);
            var pins=new List<IDisposable>();
            try {
                ReadAdministrativeInput(Path.Combine(productRoot,"owner-msi.prepared.json"),pins,8192);
                if(Encoding.UTF8.GetString(ReadAdministrativeInput(Path.Combine(productRoot,"owner-identity.initialize-lock"),pins,128))!="agentoc-owner-identity-initialization-v1\n")throw new InvalidOperationException("SHT_INITIALIZATION_LEASE_REQUIRED");
                foreach(var relative in new[]{"node.exe",@"scripts\initialize-windows-owner-identity.mjs",@"lib\instance-identity.mjs",@"lib\instance-proof-protocol.mjs",@"lib\windows-owner-identity-paths.mjs"}) {
                    string path=Path.Combine(workingDirectory,relative);
                    ReadAdministrativeInput(path,pins,157286400);
                }
                foreach(var name in new[]{"instance-identity.json","instance-identity.json.initialize-lock","instance-identity.json.pending","auth-session-secret","auth-sessions.sqlite","owner-identity.result.json"}) {
                    try {File.GetAttributes(Path.Combine(configDirectory,name));throw new InvalidOperationException("SHT_INITIALIZATION_EXISTING_STATE");}
                    catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
                }
                RequestAdditionalTime(45000);
                var start=BuildChildStartInfoCore(true);start.Arguments=Quote(Path.Combine(workingDirectory,@"scripts\initialize-windows-owner-identity.mjs"));
                using(var oneShot=new Process{StartInfo=start}) {
                    if(!oneShot.Start())throw new InvalidOperationException("SHT_INITIALIZATION_START_FAILED");
                    int outputBytes=0;
                    oneShot.OutputDataReceived+=(s,e)=>{if(e.Data!=null)System.Threading.Interlocked.Add(ref outputBytes,e.Data.Length);};
                    oneShot.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)System.Threading.Interlocked.Add(ref outputBytes,e.Data.Length);};
                    oneShot.BeginOutputReadLine();oneShot.BeginErrorReadLine();
                    try {
                        ServiceToken.VerifyChild(oneShot,ServiceName);
                        if(!oneShot.WaitForExit(30000))throw new InvalidOperationException("SHT_INITIALIZATION_TIMEOUT");
                        oneShot.WaitForExit();
                        if(oneShot.ExitCode!=0 || outputBytes>4096)throw new InvalidOperationException("SHT_INITIALIZATION_CHILD_REFUSED");
                        var result="{\"version\":1,\"initialized\":true,\"hostPid\":"+Process.GetCurrentProcess().Id+",\"nodePid\":"+oneShot.Id+",\"sid\":\""+WindowsIdentity.GetCurrent().User.Value+"\",\"sessionId\":0,\"integrityRid\":8192,\"onlyChangeNotify\":true}";
                        using(var file=new FileStream(Path.Combine(configDirectory,"owner-identity.result.json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
                            var bytes=Encoding.UTF8.GetBytes(result);file.Write(bytes,0,bytes.Length);file.Flush(true);
                        }
                    } finally {if(!oneShot.HasExited){oneShot.Kill();oneShot.WaitForExit(5000);}}
                }
                ExitCode=0;
                System.Threading.ThreadPool.QueueUserWorkItem(s=>{System.Threading.Thread.Sleep(100);try{Stop();}catch{}});
            } finally {for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
        }

        private static byte[] ReadAdministrativeInput(string path,List<IDisposable> pins,int maximum) {
            var admins=new HashSet<string>(new[]{"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"});
            for(string p=Path.GetDirectoryName(path);p!=null;p=Path.GetDirectoryName(p)) {
                pins.Add(ServiceDirectoryPin.Directory(p));var directory=Directory.GetAccessControl(p);
                if(!admins.Contains(directory.GetOwner(typeof(SecurityIdentifier)).Value))throw new InvalidOperationException("SHT_INITIALIZATION_INPUT_OWNER");
                bool needsWitness=false;
                foreach(FileSystemAccessRule rule in directory.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                    if(rule.AccessControlType!=AccessControlType.Allow||(rule.PropagationFlags&PropagationFlags.InheritOnly)!=0||admins.Contains(rule.IdentityReference.Value))continue;
                    long rights=(long)rule.FileSystemRights;
                    if((rights&0x500d0152L)==0)continue;
                    if(!AllowPinnedProgramDataAncestor(p,rights))throw new InvalidOperationException("SHT_INITIALIZATION_INPUT_WRITABLE "+AdministrativeInputStage(p,path,false));
                    needsWitness=true;
                }
                if(needsWitness)pins.AddRange(ServiceDirectoryPin.NonemptyDirectory(ProgramDataPath(),Path.Combine(ProgramDataPath(),"Microsoft")));
            }
            var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);pins.Add(file);
            ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);
            var acl=File.GetAccessControl(path);
            if(!admins.Contains(acl.GetOwner(typeof(SecurityIdentifier)).Value))throw new InvalidOperationException("SHT_INITIALIZATION_INPUT_OWNER");
            foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&(rule.PropagationFlags&PropagationFlags.InheritOnly)==0&&!admins.Contains(rule.IdentityReference.Value)&&((long)rule.FileSystemRights&0x500d0156L)!=0)throw new InvalidOperationException("SHT_INITIALIZATION_INPUT_WRITABLE "+AdministrativeInputStage(path,path,true));
            if(file.Length<1||file.Length>maximum)throw new InvalidOperationException("SHT_INITIALIZATION_INPUT_SIZE");
            if(maximum>8192)return null;
            var bytes=new byte[file.Length];int offset=0;while(offset<bytes.Length){int count=file.Read(bytes,offset,bytes.Length-offset);if(count<=0)throw new InvalidOperationException("SHT_INITIALIZATION_INPUT_TRUNCATED");offset+=count;}return bytes;
        }

        private static bool AllowPinnedProgramDataAncestor(string path,long rights) {
            return String.Equals(Path.GetFullPath(path).TrimEnd('\\'),ProgramDataPath(),StringComparison.OrdinalIgnoreCase)
                && (rights&0x500d0040L)==0;
        }

        // Report only a fixed category, never an installation path, identity,
        // ACL content, or credential. The checks themselves remain unchanged.
        private static string AdministrativeInputStage(string ancestor,string input,bool file) {
            if(file)return "SHT_INPUT_FILE";
            string full=Path.GetFullPath(ancestor).TrimEnd('\\');
            string root=Path.GetPathRoot(ancestor).TrimEnd('\\');
            if(String.Equals(full,root,StringComparison.OrdinalIgnoreCase))return "SHT_INPUT_DRIVE_ROOT";
            if(String.Equals(full,ProgramDataPath(),StringComparison.OrdinalIgnoreCase))return "SHT_INPUT_PROGRAMDATA";
            if(String.Equals(full,Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))return "SHT_INPUT_PROGRAM_FILES";
            if(String.Equals(full,Path.GetDirectoryName(input).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))return "SHT_INPUT_PARENT";
            return "SHT_INPUT_OTHER_ANCESTOR";
        }

        private static void CheckDataDirectory(string path,string sid,bool privateReads)
        {
            path=Path.GetFullPath(path);
            var admins=new HashSet<string>(new[] {"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"});
            for(var cursor=Path.GetFullPath(path);cursor!=null;cursor=Path.GetDirectoryName(cursor)) {
                ServiceDirectoryPin.Lifetime.Add(ServiceDirectoryPin.Directory(cursor));
                if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("SHT_DATA_REPARSE_REFUSED");
                var acl=Directory.GetAccessControl(cursor);
                if(!admins.Contains(acl.GetOwner(typeof(SecurityIdentifier)).Value)) throw new InvalidOperationException("SHT_DATA_OWNER_REFUSED");
                bool target=String.Equals(cursor,path,StringComparison.OrdinalIgnoreCase);
                if(target&&!acl.AreAccessRulesProtected) throw new InvalidOperationException("SHT_DATA_INHERITANCE_REFUSED");
                bool needsWitness=false;
                foreach(FileSystemAccessRule ace in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                    if(ace.AccessControlType!=AccessControlType.Allow || (ace.PropagationFlags&PropagationFlags.InheritOnly)!=0) continue;
                    string identity=ace.IdentityReference.Value;
                    if(admins.Contains(identity) || (target&&identity==sid)) continue;
                    long mask=target?(privateReads?0xd00d015fL:0x500d0156L):0x500d0152L;
                    if(((long)ace.FileSystemRights&mask)!=0) {
                        if(target||!String.Equals(cursor,ProgramDataPath(),StringComparison.OrdinalIgnoreCase)||((long)ace.FileSystemRights&0x500d0040L)!=0)throw new InvalidOperationException("SHT_DATA_FOREIGN_ACCESS_REFUSED");
                        needsWitness=true;
                    }
                }
                if(needsWitness)ServiceDirectoryPin.Lifetime.AddRange(ServiceDirectoryPin.NonemptyDirectory(ProgramDataPath(),Path.Combine(ProgramDataPath(),"Microsoft")));
            }
        }

        private static void CopyPublicProxyEnvironment(ProcessStartInfo info)
        {
            foreach (var name in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY" })
            {
                var value = Environment.GetEnvironmentVariable(name);
                if (String.IsNullOrWhiteSpace(value) || value.Length > 4096) continue;
                if (!value.Contains("://")) value = "http://" + value;
                Uri uri;
                if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || String.IsNullOrEmpty(uri.Host)
                    || !String.IsNullOrEmpty(uri.UserInfo)) continue;
                if (uri.Scheme != "http" && uri.Scheme != "https" && uri.Scheme != "socks"
                    && uri.Scheme != "socks4" && uri.Scheme != "socks4a" && uri.Scheme != "socks5" && uri.Scheme != "socks5h") continue;
                // Match network-proxy.mjs: endpoint only, no URL credentials,
                // query, fragment or arbitrary path inherited from the parent.
                info.EnvironmentVariables[name] = new UriBuilder(uri) { Path = "", Query = "", Fragment = "" }.Uri.AbsoluteUri;
            }
            foreach (var name in new[] { "NO_PROXY" })
            {
                var value = Environment.GetEnvironmentVariable(name);
                if (!String.IsNullOrEmpty(value) && value.Length <= 4096 && value.IndexOfAny(new[] { '\0', '\r', '\n' }) < 0)
                    info.EnvironmentVariables[name] = value;
            }
        }

        protected override void OnStop()
        {
            // Serialize the stop decision with the final start check. A
            // backoff wake-up cannot launch after this stop linearizes.
            lock(childGate){stopping=true;recoveryStop.Set();if(supervisorPipe!=null){supervisorPipe.Dispose();supervisorPipe=null;}if(childOwnership!=null){childOwnership.Dispose();childOwnership=null;}StopChild();}
            WriteEvent(1001, EventLogEntryType.Information, "AgentoC " + role + " service stopped.");
        }

        protected override void OnShutdown()
        {
            lock(childGate){stopping=true;recoveryStop.Set();if(supervisorPipe!=null){supervisorPipe.Dispose();supervisorPipe=null;}if(childOwnership!=null){childOwnership.Dispose();childOwnership=null;}StopChild();}
            base.OnShutdown();
        }

        private void ChildExited(object sender, EventArgs args)
        {
            var exited=sender as Process;
            if (stopping) return;
            if (exited==null) return;
            // Handle the old generation, never whatever child happens to be in
            // the field when this callback eventually runs.
            ThreadPool.QueueUserWorkItem(s=>RecoverChild(exited));
        }

        private void RecoverChild(Process exited)
        {
            int attempt=0;bool retry=false;
            lock(childGate) {
            if(stopping||!Object.ReferenceEquals(child,exited))return;
            var exitCode = exited.ExitCode;
            try { File.AppendAllText(childLogPath, DateTime.UtcNow.ToString("o") + " child-exit code=" + exitCode + Environment.NewLine); } catch { }
            // Allow redirected stdout/stderr callbacks to drain before Stop()
            // disposes the Process object; otherwise the useful startup error
            // can be lost exactly when the service fails to start.
            try { exited.WaitForExit(5000); } catch { }
            WriteEvent(1002, EventLogEntryType.Error, "AgentoC " + role + " child process exited unexpectedly (code " + exitCode + "). See " + childLogPath + ".");
            try {
                // A successful exit may be an intentional application stop;
                // never resurrect it merely because SCM did not initiate it.
                if(role=="control"&&exitCode!=0&&childOwnership!=null&&!stopping) {
                    string outcome=childOwnership.ArchiveAfterExit(()=>stopping||recoveryStop.WaitOne(0));
                    if(recoveryWindow.ElapsedMilliseconds>=600000){recoveryWindow.Restart();recoveryAttempts=0;}
                    attempt=++recoveryAttempts;retry=attempt<=3;
                    WriteEvent(1005,EventLogEntryType.Warning,"AgentoC control child exited; ownership "+outcome+"; recovery attempt "+attempt+" of 3.");
                }
            }catch(Exception error){WriteEvent(1006,EventLogEntryType.Error,"AgentoC control recovery refused: "+(error is InvalidOperationException&&error.Message.StartsWith("SHT_",StringComparison.Ordinal)?error.Message:"SHT_OWNERSHIP_RECOVERY_REFUSED"));}
            finally{if(childOwnership!=null){childOwnership.Dispose();childOwnership=null;}}
            if(retry){exited.Dispose();child=null;}
            }
            if(retry&&!recoveryStop.WaitOne(new[]{1000,5000,15000}[attempt-1])) {
                lock(childGate) {
                    if(stopping||recoveryStop.WaitOne(0)||child!=null)return;
                    try{revalidateForRecovery();StartChild();return;}
                    catch{WriteEvent(1006,EventLogEntryType.Error,"AgentoC control child recovery startup failed.");}
                }
            }
            if(stopping)return;
            ExitCode = 1;
            try { Stop(); } catch { }
        }

        private void ChildOutputReceived(object sender, DataReceivedEventArgs args)
        {
            if (String.IsNullOrEmpty(args.Data) || String.IsNullOrEmpty(childLogPath)) return;
            try { File.AppendAllText(childLogPath, DateTime.UtcNow.ToString("o") + " " + args.Data + Environment.NewLine); } catch { }
        }

        private void StopChild()
        {
            if (child == null) return;
            var exited = false;
            try {
                Directory.CreateDirectory(Path.GetDirectoryName(stopFilePath));
                File.WriteAllText(stopFilePath, DateTime.UtcNow.ToString("o") + Environment.NewLine);
                exited = child.WaitForExit(15000);
            } catch { }
            try {
                if (!exited && !child.HasExited) {
                    using (var killer = Process.Start(new ProcessStartInfo {
                        FileName = Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                        Arguments = "/PID " + child.Id + " /T /F",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                })) killer.WaitForExit(30000);
                }
            } finally {
                try { File.Delete(stopFilePath); } catch { }
                child.Dispose();
                child = null;
            }
        }

        private string EnsureAuthSessionSecret()
        {
            var existing = ReadAuthSessionSecret();
            if (existing != null) return existing;

            var bytes = new byte[32];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            var generated = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            try
            {
                using (var stream = new FileStream(authSessionSecretPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                {
                    writer.Write(generated);
                }
                return generated;
            }
            catch (IOException)
            {
                // A concurrently starting sibling service may have created the
                // instance secret first. Reuse it rather than rotating cookies.
                existing = ReadAuthSessionSecret();
                if (existing != null) return existing;
                throw new InvalidOperationException("Unable to create the AgentoC authentication session secret.");
            }
        }

        private string ReadAuthSessionSecret()
        {
            for (var attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    if (!File.Exists(authSessionSecretPath)) return null;
                    var value = File.ReadAllText(authSessionSecretPath).Trim();
                    if (value.Length != 64 || !IsHex(value))
                        throw new InvalidOperationException("The AgentoC authentication session secret is invalid.");
                    return value;
                }
                catch (FileNotFoundException)
                {
                    return null;
                }
                catch (DirectoryNotFoundException)
                {
                    return null;
                }
                catch (IOException)
                {
                    if (attempt >= 19) throw;
                    System.Threading.Thread.Sleep(50);
                }
            }
            throw new InvalidOperationException("Unable to read the AgentoC authentication session secret.");
        }

        private static bool IsHex(string value)
        {
            foreach (var character in value)
            {
                if (!((character >= '0' && character <= '9')
                    || (character >= 'a' && character <= 'f')
                    || (character >= 'A' && character <= 'F'))) return false;
            }
            return true;
        }

        private void WriteEvent(int id, EventLogEntryType type, string message)
        {
            try { EventLog.WriteEntry("AgentoC", message, type, id); } catch { }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        public static void Main(string[] args)
        {
            if(args.Length>0&&args[0]=="--build-info") {
                Environment.ExitCode=PrintBuildInfo(args);return;
            }
            if (args.Length > 0 && args[0] == "--broker-pipe")
            {
                Environment.ExitCode = BrokerPipeClient.Run(args);
                return;
            }
            if (args.Length > 0 && args[0] == "--runner-supervisor-pipe")
            {
                Environment.ExitCode = RunnerSupervisorPipe.Client(args);
                return;
            }
            var role = Value(args, "--role") ?? "control";
            var payload = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "payload");
            var node = Value(args, "--node") ?? Path.Combine(payload, "node.exe");
            var script = Value(args, "--script") ?? Path.Combine(payload,
                role == "supervisor" ? Path.Combine("chat", "runner-supervisor-daemon.mjs") : "chat-server.mjs");
            var working = Value(args, "--working-directory") ?? payload;
            var config = Value(args, "--config-dir") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "AgentoC", "instances", "owner", "config");
            var serviceName = role == "supervisor" ? "AgentoC-RunnerSupervisor" : "AgentoC-ControlPlane";
            var instanceRoot=Value(args,"--instance-root");
            var productRoot=Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            ServiceBase.Run(new AgentoCService(serviceName, role, node, script, working, config, instanceRoot, productRoot));
        }

        private static int PrintBuildInfo(string[] args) {
            if(args.Length!=1){Console.WriteLine("{\"ok\":false,\"code\":\"SHT_BUILD_INFO_ARGUMENTS\"}");return 2;}
            try {
                using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("AgentoC.ServiceHost.Build.json")) {
                    if(input==null){Console.WriteLine("{\"ok\":false,\"code\":\"SHT_BUILD_INFO_UNAVAILABLE\"}");return 1;}
                    if(input.Length<1||input.Length>8192)throw new InvalidOperationException();
                    var bytes=new byte[input.Length];int offset=0;while(offset<bytes.Length){int n=input.Read(bytes,offset,bytes.Length-offset);if(n<=0)throw new InvalidOperationException();offset+=n;}
                    var info=OwnedChildMarker.FlatJson(bytes,new[]{"schemaVersion","purpose","sourceCommit","ownershipProtocolVersion","sourceManifestSha256","allowlistSha256","serviceHostSourceSha256","instanceRuntimeSha256","instanceOwnershipSha256"});
                    if(!(info["schemaVersion"] is int)||(int)info["schemaVersion"]!=1||info["purpose"] as string!="windows-service-host-build"||!(info["ownershipProtocolVersion"] is int)||(int)info["ownershipProtocolVersion"]!=OwnedChildMarker.ProtocolVersion||!(info["sourceCommit"] is string)||!Regex.IsMatch((string)info["sourceCommit"],@"\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z"))throw new InvalidOperationException();
                    foreach(string key in new[]{"sourceManifestSha256","allowlistSha256","serviceHostSourceSha256","instanceRuntimeSha256","instanceOwnershipSha256"})if(!(info[key] is string)||!Regex.IsMatch((string)info[key],@"\A[a-f0-9]{64}\z"))throw new InvalidOperationException();
                    // Descriptive build provenance only. This does not inspect
                    // installed JS, establish trust, or authorize execution.
                    Console.Write(new UTF8Encoding(false,true).GetString(bytes));return 0;
                }
            }catch{Console.WriteLine("{\"ok\":false,\"code\":\"SHT_BUILD_INFO_INVALID\"}");return 1;}
        }

        private static string Value(string[] args, string key)
        {
            for (var i = 0; i + 1 < args.Length; i++) if (args[i] == key) return args[i + 1];
            return null;
        }
    }
}
