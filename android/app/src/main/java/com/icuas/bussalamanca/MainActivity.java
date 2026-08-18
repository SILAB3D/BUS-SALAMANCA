package com.icuas.bussalamanca;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BatteryOptimizationPlugin.class);
        registerPlugin(BusTrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
