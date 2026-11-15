plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
dependencies { implementation(project(":sdk:android")) }
android {
    namespace = "com.andysagent.ragent.sharefixture"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.agentoncloud.android.sharefixture"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
