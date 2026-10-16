package expo.modules.livevoiceaudio

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import expo.modules.kotlin.exception.CodedException

class LiveVoiceAudioService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var audio: AudioManager
  private var active = false
  private var previousMode: Int? = null
  private var previousSpeaker = false
  private var previousSco = false
  private var previousDevice: AudioDeviceInfo? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusOwned = false
  private var scoStarted = false
  private var callbacksRegistered = false
  private var wakeLock: PowerManager.WakeLock? = null
  private var interruption: ((String) -> Unit)? = null
  private var tick: (() -> Unit)? = null
  private val clock = object : Runnable {
    override fun run() {
      if (!active) return
      tick?.invoke()
      if (active) handler.postDelayed(this, 100)
    }
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS ||
      change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
      change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
    ) interrupt("focus_lost")
  }

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshRoute()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refreshRoute()
  }

  override fun onCreate() {
    super.onCreate()
    audio = getSystemService(AudioManager::class.java)
    instance = this
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      if (intent.getLongExtra(EXTRA_GENERATION, -1) == generation && active) interrupt("stop")
      else if (!active) finish()?.let { Log.e(TAG, "Falha ao encerrar o serviço", it) }
      return START_NOT_STICKY
    }
    if (intent == null || intent.getLongExtra(EXTRA_GENERATION, -1) != generation || requests.isEmpty()) {
      if (!active) finish()?.let { Log.e(TAG, "Falha ao encerrar o serviço sem chamada", it) }
      return START_NOT_STICKY
    }
    instance = this
    val request = requests.first()
    interruption = request.interruption
    tick = request.tick
    try {
      val notification = notification(request.options)
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      previousMode = audio.mode
      previousSpeaker = audio.isSpeakerphoneOn
      previousSco = audio.isBluetoothScoOn
      if (Build.VERSION.SDK_INT >= 31) previousDevice = audio.communicationDevice
      active = true
      acquireFocus()
      applyCommunicationAudio()
      audio.registerAudioDeviceCallback(devices, handler)
      callbacksRegistered = true
      wakeLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:live-voice")
        .also { it.acquire() }
      handler.postDelayed(clock, 100)
      settleStarts(null)
    } catch (error: Exception) {
      finish()?.let { error.addSuppressed(it) }
      settleStarts(error)
    }
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    interrupt("audio_interrupted")
    finish()?.let { Log.e(TAG, "Falha ao encerrar a chamada removida", it) }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    if (active) {
      try {
        interruption?.invoke("audio_interrupted")
      } catch (error: Exception) {
        Log.e(TAG, "Falha ao avisar a interrupção", error)
      }
    }
    releaseAudio()?.let { Log.e(TAG, "Falha ao restaurar o áudio", it) }
    stopForeground(STOP_FOREGROUND_REMOVE)
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun notification(options: LiveVoiceAudioOptions): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, options.title, NotificationManager.IMPORTANCE_LOW))
      if (manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
        throw CodedException("notifications_permission", "Ative as notificações da chamada.", null)
      }
    }
    val stop = PendingIntent.getService(
      this, 0, Intent(this, LiveVoiceAudioService::class.java).setAction(ACTION_STOP).putExtra(EXTRA_GENERATION, generation),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    builder.setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(options.title)
      .setContentText(options.body)
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, options.stopLabel, stop).build())
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setContentIntent(PendingIntent.getActivity(this, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    return builder.build()
  }

  private fun acquireFocus() {
    val result = if (Build.VERSION.SDK_INT >= 26) {
      val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener(focusListener, handler)
        .build().also { focusRequest = it }
      audio.requestAudioFocus(request)
    } else {
      audio.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
    }
    check(result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Não foi possível obter o foco de áudio." }
    focusOwned = true
  }

  private fun applyCommunicationAudio() {
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    routeAudio()
  }

  private fun routeAudio() {
    val bluetoothAllowed = checkSelfPermission(
      if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_CONNECT else Manifest.permission.BLUETOOTH
    ) == PackageManager.PERMISSION_GRANTED
    val priorities = listOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_HEARING_AID, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    )
    val bluetoothTypes = setOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_HEARING_AID)
    val available = if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices
      else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    val target = available.filter { it.type in priorities && (bluetoothAllowed || it.type !in bluetoothTypes) }
      .minByOrNull { priorities.indexOf(it.type) }
      ?: throw IllegalStateException("Nenhuma saída de áudio está disponível para a chamada.")
    if (Build.VERSION.SDK_INT >= 31) {
      if (audio.communicationDevice?.id != target.id) {
        check(audio.setCommunicationDevice(target)) { "Não foi possível selecionar a saída de áudio da chamada." }
      }
    } else {
      val useSco = target.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
      if (useSco && !scoStarted && !previousSco) {
        audio.startBluetoothSco()
        scoStarted = true
      } else if (!useSco && scoStarted) {
        audio.stopBluetoothSco()
        scoStarted = false
      }
      audio.isBluetoothScoOn = useSco
      audio.isSpeakerphoneOn = target.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }
  }

  private fun refreshRoute() {
    if (!active) return
    try {
      routeAudio()
    } catch (error: Exception) {
      Log.e(TAG, "Falha ao trocar a saída de áudio", error)
      interrupt("audio_interrupted")
    }
  }

  private fun interrupt(reason: String) {
    if (!active) return
    try {
      interruption?.invoke(reason)
    } finally {
      finish()?.let { Log.e(TAG, "Falha ao encerrar a chamada interrompida", it) }
    }
  }

  private fun releaseAudio(): Throwable? {
    active = false
    handler.removeCallbacks(clock)
    tick = null
    var failure: Throwable? = null
    fun attempt(action: () -> Unit) {
      try { action() } catch (error: Exception) {
        if (failure == null) failure = error else failure!!.addSuppressed(error)
      }
    }
    if (callbacksRegistered) {
      callbacksRegistered = false
      attempt { audio.unregisterAudioDeviceCallback(devices) }
    }
    wakeLock?.let { lock ->
      wakeLock = null
      attempt { if (lock.isHeld) lock.release() }
    }
    if (focusOwned) {
      focusOwned = false
      attempt {
        val result = if (Build.VERSION.SDK_INT >= 26) audio.abandonAudioFocusRequest(requireNotNull(focusRequest))
          else audio.abandonAudioFocus(focusListener)
        check(result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Não foi possível liberar o foco de áudio." }
      }
    }
    focusRequest = null
    previousMode?.let { mode ->
      previousMode = null
      if (Build.VERSION.SDK_INT >= 31) {
        val device = previousDevice
        previousDevice = null
        attempt {
          if (device != null && audio.availableCommunicationDevices.any { it.id == device.id }) {
            check(audio.setCommunicationDevice(device)) { "Não foi possível restaurar a saída de áudio." }
          } else audio.clearCommunicationDevice()
        }
      } else {
        if (scoStarted) attempt { audio.stopBluetoothSco() }
        scoStarted = false
        attempt { audio.isBluetoothScoOn = previousSco }
        attempt { audio.isSpeakerphoneOn = previousSpeaker }
      }
      attempt { audio.mode = mode }
    }
    interruption = null
    return failure
  }

  private fun finish(): Throwable? {
    val failure = releaseAudio()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    if (instance === this) instance = null
    return failure
  }

  companion object {
    private const val TAG = "LiveVoiceAudio"
    private const val CHANNEL_ID = "hangar-live-voice"
    private const val NOTIFICATION_ID = 9241
    private const val ACTION_STOP = "expo.modules.livevoiceaudio.STOP"
    private const val EXTRA_GENERATION = "generation"
    private val main = Handler(Looper.getMainLooper())
    private var instance: LiveVoiceAudioService? = null
    private var generation = 0L
    private val requests = mutableListOf<StartRequest>()
    private var startupTimeout: Runnable? = null

    private data class StartRequest(
      val options: LiveVoiceAudioOptions,
      val interruption: (String) -> Unit,
      val tick: () -> Unit,
      val complete: (Throwable?) -> Unit
    )

    fun isActive() = instance?.active == true

    fun start(context: Context, options: LiveVoiceAudioOptions, interruption: (String) -> Unit, tick: () -> Unit, complete: (Throwable?) -> Unit) {
      val current = instance
      if (current?.active == true) {
        try {
          current.acquireFocus()
          current.applyCommunicationAudio()
          complete(null)
        } catch (error: Exception) {
          current.finish()?.let { error.addSuppressed(it) }
          complete(error)
        }
        return
      }
      requests.add(StartRequest(options, interruption, tick, complete))
      if (requests.size > 1) return
      val token = ++generation
      startupTimeout = Runnable {
        if (token == generation && requests.isNotEmpty()) {
          val error = IllegalStateException("O serviço de áudio não iniciou a tempo.")
          instance?.finish()?.let { error.addSuppressed(it) }
          context.stopService(Intent(context, LiveVoiceAudioService::class.java))
          settleStarts(error)
        }
      }.also { main.postDelayed(it, 10_000) }
      try {
        val intent = Intent(context, LiveVoiceAudioService::class.java).putExtra(EXTRA_GENERATION, token)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      } catch (error: Exception) {
        settleStarts(error)
      }
    }

    fun stop(context: Context) {
      ++generation
      settleStarts(CodedException("audio_cancelled", "A abertura da chamada foi cancelada.", null))
      val failure = instance?.finish()
      context.stopService(Intent(context, LiveVoiceAudioService::class.java))
      if (failure != null) throw CodedException("audio_restore", "Não foi possível restaurar o áudio: ${failure.localizedMessage}", failure)
    }

    private fun settleStarts(error: Throwable?) {
      startupTimeout?.let { main.removeCallbacks(it) }
      startupTimeout = null
      val pending = requests.toList()
      requests.clear()
      pending.forEach { it.complete(error) }
    }
  }
}
