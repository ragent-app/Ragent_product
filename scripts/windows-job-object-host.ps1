param(
  [switch]$PreserveOnControllerExit,
  [string]$PipeName = ''
)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.ComponentModel;
using System.IO;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RagentJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct StartupInfo {
    public int Cb;
    public IntPtr Reserved;
    public IntPtr Desktop;
    public IntPtr Title;
    public int X;
    public int Y;
    public int XSize;
    public int YSize;
    public int XCountChars;
    public int YCountChars;
    public int FillAttribute;
    public int Flags;
    public short ShowWindow;
    public short Reserved2;
    public IntPtr Reserved2Pointer;
    public IntPtr StdInput;
    public IntPtr StdOutput;
    public IntPtr StdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInformation {
    public IntPtr Process;
    public IntPtr Thread;
    public uint ProcessId;
    public uint ThreadId;
  }

  public sealed class ManagedProcess {
    public IntPtr Process;
    public IntPtr Thread;
    public uint ProcessId;
    public IntPtr StdinWrite;
    public IntPtr StdoutRead;
    public IntPtr StderrRead;
    public int Closed;
    public int ReadersStarted;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr h, int c, IntPtr i, int l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j, uint e);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, int l, out int r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(uint handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string cwd, ref StartupInfo startupInfo, out ProcessInformation processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadFile(IntPtr file, [Out] byte[] buffer, int length, out int read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteFile(IntPtr file, IntPtr buffer, uint length, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  public const uint PROCESS_ASSIGN_TO_JOB = 0x00000101;
  public const uint HANDLE_FLAG_INHERIT = 0x00000001;
  public const uint GENERIC_READ = 0x80000000;
  public const uint GENERIC_WRITE = 0x40000000;
  public const uint FILE_SHARE_READ = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint OPEN_EXISTING = 3;
  public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  public const uint CREATE_SUSPENDED = 0x00000004;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  public const int STARTF_USESTDHANDLES = 0x00000100;
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  public const int JobObjectBasicProcessIdList = 3;

  [StructLayout(LayoutKind.Sequential)] public struct Basic { public long processTime; public long jobTime; public int flags; public UIntPtr min; public UIntPtr max; public int activeProcessLimit; public UIntPtr affinity; public int priority; public int scheduling; }
  [StructLayout(LayoutKind.Sequential)] public struct Counters { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic basic; public Counters counters; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }

  private static readonly object OutputLock = new object();
  private static int OutputDisabled;
  public static TextWriter Output;

  public static void EmitJson(string value) {
    lock (OutputLock) {
      if(Interlocked.CompareExchange(ref OutputDisabled, 0, 0) != 0) return;
      var writer = Output ?? Console.Out;
      try {
        writer.WriteLine(value);
        writer.Flush();
      } catch {
        // A controller crash closes the response pipe. Keep consuming provider
        // output so a live child never receives a broken stdout/stderr pipe.
        Interlocked.Exchange(ref OutputDisabled, 1);
      }
    }
  }

  public static IntPtr Create() {
    var h=CreateJobObjectW(IntPtr.Zero,null);
    if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var i=new Extended();
    i.basic.flags=(int)JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    var p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended)));
    try {
      Marshal.StructureToPtr(i,p,false);
      if(!SetInformationJobObject(h,JobObjectExtendedLimitInformation,p,Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
    return h;
  }

  public static void Assign(IntPtr j, uint pid) {
    var p=OpenProcess(PROCESS_ASSIGN_TO_JOB,false,pid);
    if(p==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { if(!AssignProcessToJobObject(j,p)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    finally { CloseHandle(p); }
  }

  public static long[] List(IntPtr j) {
    int initialSize = 8 + 8192 * IntPtr.Size;
    var buffer = Marshal.AllocHGlobal(initialSize);
    int needed;
    try {
      if(!QueryInformationJobObject(j, JobObjectBasicProcessIdList, buffer, initialSize, out needed)) {
        int err = Marshal.GetLastWin32Error();
        if(err == 234 || err == 122) {
          int required = needed > 0 ? needed : initialSize * 2;
          Marshal.FreeHGlobal(buffer);
          buffer = Marshal.AllocHGlobal(required);
          if(!QueryInformationJobObject(j, JobObjectBasicProcessIdList, buffer, required, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } else throw new Win32Exception(err);
      }
      uint count = (uint)Marshal.ReadInt32(buffer, 4);
      var pids = new long[count];
      for(uint idx=0; idx<count; idx++) pids[idx] = Marshal.ReadInt64(buffer, 8 + (int)idx * IntPtr.Size);
      return pids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  private static IntPtr OpenNull(uint access, ref SecurityAttributes attributes) {
    var handle = CreateFileW("NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, ref attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
    if(handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }

  private static void CloseIfValid(IntPtr handle) {
    if(handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
  }

  private static void DisableInheritedStandardHandle(uint standardHandle) {
    var handle = GetStdHandle(standardHandle);
    if(handle != IntPtr.Zero && handle != new IntPtr(-1)) {
      SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
    }
  }

  public static void DisableInheritedControllerHandles() {
    // The provider gets only the three explicit stdio pipe handles below.
    // Without this, CreateProcessW can also inherit the host's controller
    // stdin pipe, so a broker/controller crash leaves the Job host waiting
    // forever for EOF and cannot close the Job Object.
    DisableInheritedStandardHandle(0xFFFFFFF6); // STD_INPUT_HANDLE
    DisableInheritedStandardHandle(0xFFFFFFF5); // STD_OUTPUT_HANDLE
    DisableInheritedStandardHandle(0xFFFFFFF4); // STD_ERROR_HANDLE
  }

  private static string QuoteArg(string value) {
    var text = value ?? "";
    if(text.Length == 0) return "\"\"";
    bool needsQuotes = false;
    foreach(char c in text) if(char.IsWhiteSpace(c) || c == '\"') { needsQuotes = true; break; }
    if(!needsQuotes) return text;
    var result = new StringBuilder();
    result.Append('\"');
    int slashes = 0;
    foreach(char c in text) {
      if(c == '\\') { slashes++; continue; }
      if(c == '\"') {
        result.Append(new string('\\', slashes * 2 + 1));
        result.Append('\"');
        slashes = 0;
        continue;
      }
      if(slashes > 0) { result.Append(new string('\\', slashes)); slashes = 0; }
      result.Append(c);
    }
    if(slashes > 0) result.Append(new string('\\', slashes * 2));
    result.Append('\"');
    return result.ToString();
  }

  public static string BuildCommandLine(string application, string[] args, bool verbatim) {
    var result = new StringBuilder(QuoteArg(application));
    if(args != null) foreach(var arg in args) result.Append(' ').Append(verbatim ? (arg ?? "") : QuoteArg(arg));
    return result.ToString();
  }

  public static ManagedProcess CreateProcess(IntPtr job, string application, string[] args, string cwd, string environment, bool verbatim, bool stdinPipe, bool stdoutPipe, bool stderrPipe) {
    var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
    IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
    IntPtr processEnvironment = IntPtr.Zero;
    try {
      if(stdinPipe) {
        if(!CreatePipe(out stdinRead, out stdinWrite, ref attributes, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(!SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } else stdinRead = OpenNull(GENERIC_READ, ref attributes);
      if(stdoutPipe) {
        if(!CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } else stdoutWrite = OpenNull(GENERIC_WRITE, ref attributes);
      if(stderrPipe) {
        if(!CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(!SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } else stderrWrite = OpenNull(GENERIC_WRITE, ref attributes);

      var startup = new StartupInfo {
        Cb = Marshal.SizeOf(typeof(StartupInfo)),
        Flags = STARTF_USESTDHANDLES,
        StdInput = stdinRead,
        StdOutput = stdoutWrite,
        StdError = stderrWrite,
      };
      DisableInheritedControllerHandles();
      if(environment != null) processEnvironment = Marshal.StringToHGlobalUni(environment);
      var commandLine = new StringBuilder(BuildCommandLine(application, args, verbatim));
      ProcessInformation info;
      if(String.IsNullOrWhiteSpace(application)) throw new ArgumentException("managed process executable is required");
      if(!CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, processEnvironment, String.IsNullOrWhiteSpace(cwd) ? null : cwd, ref startup, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());

      var managed = new ManagedProcess { Process = info.Process, Thread = info.Thread, ProcessId = info.ProcessId, StdinWrite = stdinWrite, StdoutRead = stdoutRead, StderrRead = stderrRead };
      CloseIfValid(stdinRead); CloseIfValid(stdoutWrite); CloseIfValid(stderrWrite);
      // Ownership of these parent-side handles moves to ManagedProcess. The
      // finally block must not close them after CreateProcess returns.
      stdinRead = stdoutWrite = stderrWrite = IntPtr.Zero;
      stdinWrite = stdoutRead = stderrRead = IntPtr.Zero;
      try {
        Assign(job, info.ProcessId);
        if(ResumeThread(info.Thread) == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
      } catch {
        TerminateJobObject(job, 0xC0DE);
        CloseProcess(managed);
        throw;
      }
      return managed;
    } finally {
      if(processEnvironment != IntPtr.Zero) Marshal.FreeHGlobal(processEnvironment);
      CloseIfValid(stdinRead); CloseIfValid(stdinWrite); CloseIfValid(stdoutRead); CloseIfValid(stdoutWrite); CloseIfValid(stderrRead); CloseIfValid(stderrWrite);
    }
  }

  public static void WriteStdin(ManagedProcess process, byte[] data) {
    if(process == null || process.StdinWrite == IntPtr.Zero) throw new InvalidOperationException("managed process stdin is closed");
    var bytes = data ?? new byte[0];
    using(var safeHandle = new SafeFileHandle(process.StdinWrite, false))
    using(var stream = new FileStream(safeHandle, FileAccess.Write, 4096, false)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush();
    }
  }

  public static void CloseStdin(ManagedProcess process) {
    if(process == null) return;
    var handle = process.StdinWrite;
    process.StdinWrite = IntPtr.Zero;
    CloseIfValid(handle);
  }

  public static void StartReaders(ManagedProcess process) {
    if(process == null || Interlocked.Exchange(ref process.ReadersStarted, 1) != 0) return;
    uint pid = process.ProcessId;
    new Thread(() => ReadLoop(process, true, "stdout")) { IsBackground = true }.Start();
    new Thread(() => ReadLoop(process, false, "stderr")) { IsBackground = true }.Start();
    new Thread(() => WaitLoop(process, pid)) { IsBackground = true }.Start();
  }

  public static void WaitForProcess(ManagedProcess process) {
    if(process == null || process.Process == IntPtr.Zero) return;
    WaitForSingleObject(process.Process, 0xFFFFFFFF);
  }

  private static void ReadLoop(ManagedProcess process, bool stdout, string stream) {
    var handle = stdout
      ? Interlocked.Exchange(ref process.StdoutRead, IntPtr.Zero)
      : Interlocked.Exchange(ref process.StderrRead, IntPtr.Zero);
    var buffer = new byte[8192];
    try {
      while(handle != IntPtr.Zero) {
        int read;
        if(!ReadFile(handle, buffer, buffer.Length, out read, IntPtr.Zero) || read <= 0) break;
        var data = new byte[read];
        Buffer.BlockCopy(buffer, 0, data, 0, read);
        EmitJson("{\"event\":\"" + stream + "\",\"data\":\"" + Convert.ToBase64String(data) + "\"}");
      }
    } finally { CloseIfValid(handle); }
  }

  private static void WaitLoop(ManagedProcess process, uint pid) {
    WaitForSingleObject(process.Process, 0xFFFFFFFF);
    uint code;
    if(!GetExitCodeProcess(process.Process, out code)) code = 1;
    try { EmitJson("{\"event\":\"exit\",\"pid\":" + pid + ",\"code\":" + code + "}"); }
    catch { }
  }

  public static void CloseProcess(ManagedProcess process) {
    if(process == null || Interlocked.Exchange(ref process.Closed, 1) != 0) return;
    CloseStdin(process);
    CloseIfValid(process.StdoutRead); process.StdoutRead = IntPtr.Zero;
    CloseIfValid(process.StderrRead); process.StderrRead = IntPtr.Zero;
    CloseIfValid(process.Thread); process.Thread = IntPtr.Zero;
    CloseIfValid(process.Process); process.Process = IntPtr.Zero;
  }
}
'@

$job = [RagentJob]::Create()
$process = $null
$closeRequested = $false
$controllerDisconnected = $false
$preserveOnControllerExit = $PreserveOnControllerExit -or $env:RAGENT_WINDOWS_JOB_PRESERVE_ON_CONTROLLER_EOF -eq '1'
$pipeServer = $null
$pipeReader = $null
$pipeWriter = $null
$inputReader = [Console]::In
if (-not [string]::IsNullOrWhiteSpace($PipeName)) {
  $pipeServer = [IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $PipeName,
    [IO.Pipes.PipeDirection]::InOut,
    [IO.Pipes.PipeOptions]::Asynchronous
  )
  $pipeServer.Connect(10000)
  $utf8 = [Text.UTF8Encoding]::new($false)
  $pipeReader = [IO.StreamReader]::new($pipeServer, $utf8, $false, 65536, $true)
  $pipeWriter = [IO.StreamWriter]::new($pipeServer, $utf8, 65536, $true)
  $pipeWriter.AutoFlush = $true
  $inputReader = $pipeReader
  [RagentJob]::Output = $pipeWriter
}
[RagentJob]::EmitJson(([ordered]@{
  ok = $true
  ready = $true
  preserveOnControllerExit = [bool]$preserveOnControllerExit
} | ConvertTo-Json -Compress))
try {
  try {
    while (($line = $inputReader.ReadLine()) -ne $null) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $request = $null
      $id = 0
      try {
        $request = $line | ConvertFrom-Json
        if ($null -ne $request -and $null -ne $request.id) { $id = [int]$request.id }
        if ($request.type -eq 'create') {
          if ($null -ne $process) { throw 'one managed process is already active for this Job host' }
          $envEntries = @()
          if ($null -ne $request.env) {
            $envEntries = @($request.env.psobject.Properties | ForEach-Object { "$($_.Name)=$([string]$_.Value)" } | Sort-Object)
          }
          $envBlock = if ($null -eq $request.env) { $null } else { ($envEntries -join ([char]0)) + ([char]0) + ([char]0) }
          $args = @($request.args | ForEach-Object { [string]$_ })
          $stdio = $request.stdio
          $process = [RagentJob]::CreateProcess(
            $job,
            [string]$request.file,
            $args,
            [string]$request.cwd,
            $envBlock,
            [bool]$request.windowsVerbatimArguments,
            ($null -eq $stdio -or [bool]$stdio.stdin),
            ($null -eq $stdio -or [bool]$stdio.stdout),
            ($null -eq $stdio -or [bool]$stdio.stderr)
          )
          $response = [ordered]@{ id = $id; ok = $true; created = $true; pid = [uint32]$process.ProcessId }
          [RagentJob]::EmitJson(($response | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'start-readers') {
          [RagentJob]::StartReaders($process)
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; started = $true } | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'assign') {
          [RagentJob]::Assign($job, [uint32]$request.pid)
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; assigned = $true } | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'stdin') {
          [RagentJob]::WriteStdin($process, [Convert]::FromBase64String([string]$request.data))
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; written = $true } | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'stdin-close') {
          [RagentJob]::CloseStdin($process)
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; closed = $true } | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'list') {
          $pids=[RagentJob]::List($job)
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; pids = @($pids) } | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'terminate') {
          [RagentJob]::TerminateJobObject($job, [uint32]$request.code) | Out-Null
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; terminated = $true } | ConvertTo-Json -Compress))
        }
        elseif ($request.type -eq 'close') {
          [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $true; closed = $true } | ConvertTo-Json -Compress))
          $closeRequested = $true
          break
        }
        else { throw 'unsupported job command' }
      } catch {
        [RagentJob]::EmitJson(([ordered]@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
      }
    }
    $controllerDisconnected = -not $closeRequested
  } catch {
    # A controller taskkill can surface as a broken-pipe exception instead of
    # a null ReadLine result. Treat both forms as the same EOF contract.
    if ($closeRequested -or -not $preserveOnControllerExit) { throw }
    $controllerDisconnected = $true
  }
  # If the controller disappeared without sending close, keep the Job Object
  # alive until its child exits. This preserves the managed-process restart
  # contract; the finally block then closes the Job and prevents a host leak.
  if ($controllerDisconnected -and $preserveOnControllerExit -and $null -ne $process) {
    [RagentJob]::WaitForProcess($process)
  }
} finally {
  # Do not rely on KILL_ON_JOB_CLOSE alone for an unexpected controller EOF.
  # The explicit termination also makes the controller-crash path observable
  # and closes descendants before this host releases its only Job handle.
  if ($null -ne $process -and ($closeRequested -or -not $preserveOnControllerExit)) {
    [RagentJob]::TerminateJobObject($job, 0xC0DE) | Out-Null
  }
  [RagentJob]::CloseProcess($process)
  [RagentJob]::Output = $null
  if ($pipeReader) { $pipeReader.Dispose() }
  if ($pipeWriter) { $pipeWriter.Dispose() }
  if ($pipeServer) { $pipeServer.Dispose() }
  [RagentJob]::CloseHandle($job) | Out-Null
}
