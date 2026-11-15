pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "RagentAndroid"

include(":app")
include(":core:model")
include(":core:designsystem")
include(":core:protocol")
include(":core:database")
include(":core:datastore")
include(":core:auth")
include(":core:network")
include(":core:sync")
include(":core:p2p")
include(":core:domain")
include(":core:appapi")
include(":core:appapi-contract")
include(":sdk:android")
include(":core:agentui")
include(":core:timeline")
include(":core:navigation")
include(":feature:workbench")
include(":feature:organization")
include(":feature:appapi")

include(":integration:appfunctions")
