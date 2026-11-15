plugins {
    alias(libs.plugins.android.library)

    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.andysagent.ragent.core.protocol"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core:model"))
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.eddsa)
    testImplementation(libs.kotlin.test.junit)
}
