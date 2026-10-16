package expo.modules.livevoiceaudio

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.lang.ref.WeakReference

class LiveVoiceAudioOptions : Record {
  @Field var title: String = ""
  @Field var body: String = ""
  @Field var stopLabel: String = ""
}

class LiveVoiceAudioModule : Module() {
  private var serviceContext: Context? = null

  override fun definition() = ModuleDefinition {
    Name("LiveVoiceAudio")
    Events("interruption", "tick")

    AsyncFunction("start") { options: LiveVoiceAudioOptions, promise: Promise ->
      val context = appContext.reactContext
        ?: throw CodedException("audio_context", "O contexto de áudio não está disponível.", null)
      if (options.title.isBlank() || options.body.isBlank() || options.stopLabel.isBlank()) {
        throw CodedException("audio_labels", "Informe os textos da notificação da chamada.", null)
      }
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw CodedException("microphone_permission", "Permita o microfone para iniciar a chamada.", null)
      }
      if (Build.VERSION.SDK_INT >= 33 &&
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
      ) {
        throw CodedException("notifications_permission", "Permita as notificações para controlar a chamada.", null)
      }
      if (!context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
        throw CodedException("notifications_permission", "Ative as notificações para controlar a chamada.", null)
      }
      if (!LiveVoiceAudioService.isActive()) {
        val activity = appContext.currentActivity
        val lifecycle = (activity as? LifecycleOwner)?.lifecycle
        if (activity == null || activity.isFinishing || activity.isDestroyed || lifecycle?.currentState != Lifecycle.State.RESUMED) {
          throw CodedException("app_not_visible", "Abra o app antes de iniciar a chamada.", null)
        }
      }
      serviceContext = context.applicationContext
      val owner = WeakReference(this@LiveVoiceAudioModule)
      LiveVoiceAudioService.start(context.applicationContext, options, { reason ->
        owner.get()?.sendEvent("interruption", mapOf("reason" to reason))
      }, {
        owner.get()?.sendEvent("tick", emptyMap<String, Any>())
      }) { error ->
        if (error == null) promise.resolve()
        else if (error is CodedException) promise.reject(error)
        else promise.reject("audio_start", error.localizedMessage, error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      (serviceContext ?: appContext.reactContext)?.let { LiveVoiceAudioService.stop(it) }
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      val context = serviceContext ?: appContext.reactContext?.applicationContext
      serviceContext = null
      Handler(Looper.getMainLooper()).post {
        if (context != null) {
          try {
            LiveVoiceAudioService.stop(context)
          } catch (error: Exception) {
            Log.e("LiveVoiceAudio", "Falha ao restaurar o áudio na destruição do módulo", error)
          }
        }
      }
    }
  }
}
