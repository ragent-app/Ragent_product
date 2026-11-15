plugins {
    alias(libs.plugins.android.library)

    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.andysagent.ragent.core.p2p"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The real WebRTC runtime is required for the Android main source set.
    // The JVM-only replacement below is deliberately isolated to tests.
    sourceSets {
        getByName("test") {
            kotlin.srcDir("src/webrtc-stubs/kotlin")
        }
    }
}

dependencies {
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.stream.webrtc.android)

    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlin.test.junit)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    // Android provides org.json at runtime; JVM tests need this explicit dependency.
    testImplementation("org.json:json:20231013")
}
