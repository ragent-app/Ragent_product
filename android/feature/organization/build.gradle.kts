plugins {
    alias(libs.plugins.android.library)

    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.andysagent.agentoc.feature.organization"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
}

dependencies {
    implementation(project(":core:auth"))
    implementation(project(":core:model"))
    implementation(project(":core:domain"))
    implementation(project(":core:protocol"))
    implementation(project(":core:network"))
    implementation(project(":core:designsystem"))
    implementation(project(":core:agentui"))
    implementation(project(":core:timeline"))
    implementation(project(":core:navigation"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation("androidx.compose.ui:ui-graphics")
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.kotlin.test.junit)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    debugImplementation(libs.compose.ui.tooling)
}
