plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.andysagent.ragent.integration.appfunctions"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core:appapi"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.appfunctions)
    ksp(libs.androidx.appfunctions.compiler)
}
