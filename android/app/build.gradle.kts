plugins {
    alias(libs.plugins.android.application)

    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.android.compose.screenshot)
    alias(libs.plugins.google.services) apply false
}

import java.util.Properties
import java.security.KeyStore
import java.security.MessageDigest

// Contributors can build locally without the production Firebase project and
// the owner's debug key. This opt-in is restricted to debug builds.
val openSourceBuild = providers.gradleProperty("agentocOpenSourceBuild").orNull == "true"
if (!openSourceBuild) {
    apply(plugin = "com.google.gms.google-services")
}

// Release signing key (gitignored keystore.properties). Absent -> release stays unsigned.
val keystorePropertiesFile = rootProject.file(
    providers.gradleProperty("agentocReleaseKeystorePropertiesPath").orNull ?: "keystore.properties",
)
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.isFile) load(keystorePropertiesFile.inputStream())
}
val releaseStorePath = keystoreProperties.getProperty("storeFile")?.takeIf(String::isNotBlank)
val releaseStoreFile = releaseStorePath?.let { file(it) }
val releaseStorePassword = providers.environmentVariable("AGENTOC_RELEASE_STORE_PASSWORD").orNull
    ?: keystoreProperties.getProperty("storePassword")
val releaseKeyPassword = providers.environmentVariable("AGENTOC_RELEASE_KEY_PASSWORD").orNull
    ?: keystoreProperties.getProperty("keyPassword")
val hasReleaseKeystore = keystorePropertiesFile.isFile &&
    releaseStoreFile?.isFile == true &&
    !releaseStorePassword.isNullOrBlank() && !releaseKeyPassword.isNullOrBlank() &&
    !keystoreProperties.getProperty("keyAlias").isNullOrBlank()
if (!hasReleaseKeystore) {
    logger.warn("Release signing configuration is incomplete or its keystore is missing; building an unsigned release APK.")
}
val playVersionCode = providers.gradleProperty("agentocVersionCode").orNull?.let {
    requireNotNull(it.toIntOrNull()) { "agentocVersionCode must be an integer" }
        .also { code -> require(code in 1..2_100_000_000) { "agentocVersionCode is out of range" } }
}
val playVersionName = providers.gradleProperty("agentocVersionName").orNull
val expectedDebugSigningSha256 = "258e3d0c7ad1bf68b5f519ad0c4258e3d42a38b93def21fe943c82bf85e1250c"

// A Play bundle must never silently become an unsigned or debug-signed upload.
val verifyPlayReleaseInputs = tasks.register("verifyPlayReleaseInputs") {
    doLast {
        check(hasReleaseKeystore) { "Play bundle requires a complete release keystore configuration" }
        check(playVersionCode != null && playVersionCode != 99999 && !playVersionName.isNullOrBlank()) {
            "Play bundle requires explicit agentocVersionCode and agentocVersionName"
        }
        val store = KeyStore.getInstance(releaseStoreFile!!, releaseStorePassword!!.toCharArray())
        val certificate = checkNotNull(store.getCertificate(keystoreProperties.getProperty("keyAlias"))) {
            "Release signing alias has no certificate"
        }
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { "%02x".format(it) }
        check(fingerprint != expectedDebugSigningSha256 &&
            keystoreProperties.getProperty("keyAlias") != "androiddebugkey" &&
            store.isKeyEntry(keystoreProperties.getProperty("keyAlias"))) {
            "Play bundle requires a private upload key distinct from the established debug key"
        }
    }
}
tasks.configureEach {
    if (name == "bundleRelease" || name == "signReleaseBundle") dependsOn(verifyPlayReleaseInputs)
    if (openSourceBuild && (name.contains("Release", ignoreCase = true))) {
        doFirst { error("agentocOpenSourceBuild is restricted to local debug builds") }
    }
}

// Google Cloud registers the debug OAuth client against this exact certificate.
// debug.keystore is intentionally ignored, but a generated Android default key
// would have the same subject and a different fingerprint, breaking both APK
// upgrades and Google Sign-In. Never silently substitute a new debug key.
// An explicit path lets isolated worktrees reuse the established key without
// making another keystore copy. The same fingerprint check applies below.
val debugStoreFile = rootProject.file(
    providers.gradleProperty("agentocDebugKeystorePath").orNull ?: "debug.keystore",
)
val debugStorePassword = "android"
val debugKeyAlias = "androiddebugkey"
fun verifiedDebugStore(): java.io.File {
    check(debugStoreFile.isFile) {
        "Missing established debug keystore. Restore android/debug.keystore or set -PagentocDebugKeystorePath to the original key registered in Google Cloud; do not generate a replacement."
    }
    val keyStore = KeyStore.getInstance("JKS")
    debugStoreFile.inputStream().use { keyStore.load(it, debugStorePassword.toCharArray()) }
    val certificate = checkNotNull(keyStore.getCertificate(debugKeyAlias)) {
        "The configured debug keystore does not contain alias $debugKeyAlias"
    }
    val actual = MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
        .joinToString("") { "%02x".format(it) }
    check(openSourceBuild || actual == expectedDebugSigningSha256) {
        "The configured debug keystore has an unexpected certificate. Expected $expectedDebugSigningSha256; do not use a generated debug key."
    }
    return debugStoreFile
}

android {
    namespace = "com.andysagent.agentoc"
    compileSdk = 37
    experimentalProperties["android.experimental.enableScreenshotTest"] = true
    sourceSets.getByName("main").assets.srcDir(rootProject.file("../shared"))

    defaultConfig {
        applicationId = "com.agentoncloud.android"
        minSdk = 26
        targetSdk = 36
        versionCode = playVersionCode ?: 99999
        versionName = playVersionName ?: "0.0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        getByName("debug") {
            storeFile = verifiedDebugStore()
            storePassword = debugStorePassword
            keyAlias = debugKeyAlias
            keyPassword = debugStorePassword
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
            enableV4Signing = true
        }
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = releaseStorePassword
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
            if (openSourceBuild) {
                // Keep contributor builds separate from the Play-installed app.
                applicationIdSuffix = ".opensource"
                // A source build must not silently send test traffic to the
                // hosted production account service or use its OAuth client.
                resValue("string", "accounts_directory_base_url",
                    providers.gradleProperty("agentocAccountsUrl").orElse("https://example.invalid/accounts").get())
                resValue("string", "google_server_client_id",
                    providers.gradleProperty("agentocGoogleServerClientId").orElse("invalid.apps.googleusercontent.com").get())
            }
        }
        getByName("release") {
            // Never let a release artifact inherit the debug certificate. Without
            // the configured release keystore, the release build must stay
            // unsigned instead of producing an APK that cannot upgrade a
            // release installation.
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        aidl = true
        if (openSourceBuild) resValues = true
    }
    // The in-app language selector must work even when Play initially installs
    // the app for a device using a different system language.
    bundle {
        language { enableSplit = false }
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    constraints {
        implementation(libs.androidx.fragment) {
            because("Activity Result requires Fragment >= 1.3; align compile with the resolved 1.5.7 runtime")
        }
    }
    implementation(project(":integration:appfunctions"))
    androidTestImplementation(libs.androidx.appfunctions)
    implementation(project(":core:appapi"))
    implementation(project(":core:appapi-contract"))
    implementation(libs.androidx.room.runtime)
    implementation(project(":core:model"))
    implementation(project(":core:designsystem"))
    implementation(project(":core:auth"))
    implementation(project(":core:database"))
    implementation(project(":core:datastore"))
    implementation(project(":core:domain"))
    implementation(project(":core:network"))
    implementation(project(":core:p2p"))
    implementation(project(":core:protocol"))
    implementation(project(":core:sync"))
    implementation(project(":core:agentui"))
    implementation(project(":core:navigation"))
    implementation(project(":core:timeline"))
    implementation(project(":feature:workbench"))
    implementation(project(":feature:organization"))
    implementation(project(":feature:appapi"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.material3.window.size)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.firebase.messaging)

    testImplementation(libs.kotlin.test.junit)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.kotlinx.serialization.json)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation(libs.androidx.datastore.preferences)
    androidTestImplementation(libs.stream.webrtc.android)
    debugImplementation(libs.compose.ui.test.manifest)
    debugImplementation(libs.compose.ui.tooling)
}
