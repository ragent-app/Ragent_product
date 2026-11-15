package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp

@Composable
fun GoogleBrandIcon(
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) {
    Image(
        painter = painterResource(R.drawable.ic_google_g),
        contentDescription = contentDescription,
        modifier = modifier.then(Modifier.size(20.dp)),
    )
}
