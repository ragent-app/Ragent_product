# Optional computer voice recognition

Computer voice recognition uses a resident, loopback-only `whisper-server` on
the connected computer. The Windows setup package installs the runtime and
multilingual base model by default; clear the Whisper option to omit them. An
upgrade keeps the existing component choice initially and lets the user change
it. Installation alone does not start Whisper.

An owner must enable **Computer voice recognition** in Ragent Settings on the
computer that will process audio. With the option off, the Whisper process is
stopped and is not started, including after a service restart. With the option
on, Ragent starts Whisper, keeps the model loaded, and restarts the server if
it exits. Turning the option off stops it. The setting is local to each
computer. If Whisper was not installed, enable it in the Windows setup program
first; the upgrade flow keeps the current component selection by default and
lets the user change it.

On Windows, setup places the verified Whisper runtime and model under the
Ragent installation folder and configures the service paths. For a development
or manually managed installation, set both absolute paths before starting
Ragent:

```sh
export AGENTOC_LOCAL_VOICE_EXECUTABLE="/absolute/path/to/whisper-server"
export AGENTOC_LOCAL_VOICE_MODEL="/absolute/path/to/ggml-base-q5_1.bin"
# Start the Ragent server using the normal procedure for your installation.
```

The process binds only to `127.0.0.1`; the service sends a validated WAV to
that local endpoint and returns recognized text to the connected client. The
browser or Android app captures audio, shows the transcript in the draft, and
does not send the message automatically. Audio is not sent to a cloud speech
service by this local adapter.

The setting is owner-only. Browser or Android microphone permissions and
secure-context requirements still apply. Whisper runs on the connected
computer selected for recognition, which may be remote from the phone.
