package com.andysagent.ragent.feature.workbench

/** UI Back ownership only; never commits or mutates a runtime selection. */
internal class ComposerChoiceBackHandoff {
    var dismissal: WorkbenchEvent? = null
        private set

    fun observe(runtimeOpen: Boolean, effortOpen: Boolean) {
        dismissal = when {
            runtimeOpen -> WorkbenchEvent.CloseRuntimePicker
            effortOpen -> WorkbenchEvent.CloseEffortPicker
            else -> null
        }
    }

    fun dispatch(event: WorkbenchEvent) {
        when (event) {
            WorkbenchEvent.OpenRuntimePicker -> dismissal = WorkbenchEvent.CloseRuntimePicker
            WorkbenchEvent.OpenEffortPicker -> dismissal = WorkbenchEvent.CloseEffortPicker
            WorkbenchEvent.CloseRuntimePicker -> if (dismissal == event) dismissal = null
            WorkbenchEvent.CloseEffortPicker -> if (dismissal == event) dismissal = null
            is WorkbenchEvent.SelectModel -> if (dismissal == WorkbenchEvent.CloseRuntimePicker) dismissal = null
            WorkbenchEvent.CloseChat -> dismissal = null
            else -> Unit
        }
    }
}
