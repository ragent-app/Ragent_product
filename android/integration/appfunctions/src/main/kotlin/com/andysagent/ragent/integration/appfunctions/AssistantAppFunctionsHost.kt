package com.andysagent.ragent.integration.appfunctions

import com.andysagent.ragent.core.appapi.AssistantTaskBridge

/** Plain host seam; loading the Application on older Android does not load a platform service. */
interface AssistantAppFunctionsHost {
    val assistantAppFunctions: AssistantTaskBridge
}
