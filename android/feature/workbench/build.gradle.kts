plugins {
    alias(libs.plugins.android.library)

    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.andysagent.ragent.feature.workbench"
    compileSdk = 37
    defaultConfig {
        minSdk = 26
        testApplicationId = providers.gradleProperty("ragentWorkbenchTestApplicationId")
            .orElse("com.andysagent.ragent.feature.workbench.test").get()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    testOptions { unitTests.isIncludeAndroidResources = true }
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
    implementation(project(":feature:organization"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation("androidx.compose.ui:ui-graphics")
    implementation(libs.compose.ui.tooling.preview)
    // Gesture plumbing only; surfaces continue to use the app's Material 3
    // design system and custom One UI-inspired tokens.
    implementation("androidx.compose.material:material")
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.google.identity.googleid)
    testImplementation(libs.kotlin.test.junit)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(project(":core:database"))
    androidTestImplementation(libs.androidx.room.ktx)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    debugImplementation(libs.compose.ui.test.manifest)
}
